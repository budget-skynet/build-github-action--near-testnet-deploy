async function httpPost(url, body, headers = {}) {
  const response = await httpRequest(url, { method: 'POST', headers }, body);
  return response;
}

async function httpGet(url, headers = {}) {
  const response = await httpRequest(url, { method: 'GET', headers });
  return response;
}

// ---------------------------------------------------------------------------
// NEAR RPC helper
// ---------------------------------------------------------------------------

async function nearRpcCall(method, params, retries = MAX_RETRY) {
  const payload = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params,
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await httpPost(
        NEAR_TESTNET_RPC,
        payload,
        { 'Content-Type': 'application/json' }
      );

      if (response.statusCode !== 200) {
        throw new Error(`RPC HTTP error ${response.statusCode}: ${response.body}`);
      }

      const parsed = JSON.parse(response.body);

      if (parsed.error) {
        const errMsg = parsed.error.data || parsed.error.message || JSON.stringify(parsed.error);
        // Some errors are retryable (e.g., timeout, unknown block)
        if (attempt < retries && /timeout|unknown block|syncing/i.test(errMsg)) {
          core.warning(`RPC attempt ${attempt} failed (retryable): ${errMsg}`);
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error(`NEAR RPC error: ${errMsg}`);
      }

      return parsed.result;
    } catch (err) {
      if (attempt === retries) throw err;
      core.warning(`RPC attempt ${attempt} error: ${err.message}. Retrying...`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: run shell command with real output capture
// ---------------------------------------------------------------------------

function runCommand(cmd, options = {}) {
  core.debug(`Running command: ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });

  if (result.error) {
    throw new Error(`Command spawn error: ${result.error.message}`);
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}\n` +
      `STDOUT: ${stdout}\n` +
      `STDERR: ${stderr}`
    );
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), status: result.status };
}

// ---------------------------------------------------------------------------
// NEAR CLI helpers
// ---------------------------------------------------------------------------

function nearCliAvailable() {
  try {
    const result = spawnSync('near --version', { shell: true, encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function ensureNearCli() {
  if (!nearCliAvailable()) {
    core.info('Installing NEAR CLI...');
    runCommand('npm install -g near-cli');
    core.info('NEAR CLI installed successfully.');
  } else {
    const { stdout } = runCommand('near --version');
    core.info(`NEAR CLI available: ${stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

function generateKeyPair() {
  // Use near-cli / near-api-js approach: generate ed25519 key pair
  // We'll use the built-in crypto to create a key, then format for NEAR
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // NEAR uses raw 32-byte keys encoded as base58
  // Extract raw bytes from DER-encoded keys
  const pubKeyRaw = publicKey.slice(-32); // Last 32 bytes of SPKI DER for Ed25519
  const privKeyRaw = privateKey.slice(-32); // Last 32 bytes of PKCS8 DER for Ed25519

  const pubKeyBase58 = base58Encode(pubKeyRaw);
  const privKeyBase58 = base58Encode(Buffer.concat([privKeyRaw, pubKeyRaw]));

  return {
    publicKey: `ed25519:${pubKeyBase58}`,
    privateKey: `ed25519:${privKeyBase58}`,
    publicKeyRaw: pubKeyRaw,
    privateKeyRaw: privKeyRaw,
  };
}

function base58Encode(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';
  const base = BigInt(58);

  while (num > 0n) {
    const remainder = num % base;
    num = num / base;
    encoded = ALPHABET[Number(remainder)] + encoded;
  }

  // Add leading '1's for each leading zero byte
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }

  return encoded;
}

function writeCredentials(accountId, keyPair, credentialsDir) {
  const credFile = path.join(credentialsDir, `${accountId}.json`);
  const credData = {
    account_id: accountId,
    public_key: keyPair.publicKey,
    private_key: keyPair.privateKey,
  };
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify(credData, null, 2), { mode: 0o600 });
  core.debug(`Credentials written to: ${credFile}`);
  return credFile;
}

// ---------------------------------------------------------------------------
// Step 1: Resolve or create testnet account
// ---------------------------------------------------------------------------

async function stepCreateOrResolveAccount(inputs) {
  core.startGroup('Step 1: Create or Resolve Testnet Account');

  const { accountId, existingPrivateKey, credentialsDir, masterAccount } = inputs;

  let keyPair;
  let accountCreated = false;
  let resolvedAccountId = accountId;

  // Check if account already exists on-chain
  let accountExists = false;
  try {
    const viewResult = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (viewResult && viewResult.code_hash !== undefined) {
      accountExists = true;
      core.info(`Account ${accountId} already exists on testnet.`);
      core.info(`  Balance: ${formatNear(viewResult.amount)} NEAR`);
      core.info(`  Code hash: ${viewResult.code_hash}`);
    }
  } catch (err) {
    if (/does not exist|unknown account/i.test(err.message)) {
      accountExists = false;
      core.info(`Account ${accountId} does not exist yet. Will create it.`);
    } else {
      throw err;
    }
  }

  if (accountExists && existingPrivateKey) {
    // Use provided credentials
    keyPair = parseKeyPair(existingPrivateKey);
    core.info('Using provided private key for existing account.');
  } else if (accountExists && !existingPrivateKey) {
    // Try to load from credentials directory
    const credFile = path.join(credentialsDir, `${accountId}.json`);
    if (fs.existsSync(credFile)) {
      const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
      keyPair = parseKeyPair(cred.private_key);
      core.info('Loaded credentials from credentials directory.');
    } else {
      throw new Error(
        `Account ${accountId} exists but no private key provided and no credentials file found. ` +
        `Please provide the 'private-key' input or ensure credentials exist at ${credFile}`
      );
    }
  } else {
    // Account doesn't exist — create it via helper API
    core.info(`Creating new testnet account: ${accountId}`);
    keyPair = generateKeyPair();

    // Save credentials before attempting creation (so we can retry)
    writeCredentials(accountId, keyPair, credentialsDir);

    // Use NEAR helper to create the account
    const createPayload = {
      newAccountId: accountId,
      newAccountPublicKey: keyPair.publicKey,
    };

    let created = false;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const resp = await httpPost(
          `${NEAR_HELPER_URL}/account`,
          createPayload,
          { 'Content-Type': 'application/json' }
        );

        core.debug(`Helper response [${resp.statusCode}]: ${resp.body}`);

        if (resp.statusCode === 200 || resp.statusCode === 201) {
          created = true;
          break;
        } else if (resp.statusCode === 400) {
          const body = safeParseJSON(resp.body);
          if (body && /already exists/i.test(body.message || '')) {
            core.info('Account already exists (race condition). Proceeding.');
            created = true;
            break;
          }
          throw new Error(`Account creation failed: ${resp.body}`);
        } else {
          throw new Error(`Account creation HTTP ${resp.statusCode}: ${resp.body}`);
        }
      } catch (err) {
        if (attempt === MAX_RETRY) throw err;
        core.warning(`Account creation attempt ${attempt} failed: ${err.message}. Retrying...`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }

    if (!created) {
      throw new Error('Failed to create testnet account after all retries.');
    }

    accountCreated = true;
    core.info(`Account ${accountId} created successfully.`);

    // Wait for account to appear on-chain
    core.info('Waiting for account to be confirmed on-chain...');
    await waitForAccount(accountId);
  }

  // Set NEAR_ENV for subsequent CLI calls
  process.env.NEAR_ENV = 'testnet';
  process.env.HOME = process.env.HOME || '/root';

  // Write near credentials in the standard ~/.near-credentials/testnet/ path
  const nearCredsDir = path.join(process.env.HOME, '.near-credentials', 'testnet');
  writeCredentials(accountId, keyPair, nearCredsDir);
  writeCredentials(accountId, keyPair, credentialsDir);

  core.endGroup();

  return {
    accountId: resolvedAccountId,
    keyPair,
    accountCreated,
    credentialsDir,
    nearCredsDir,
  };
}

function parseKeyPair(privateKeyStr) {
  // We just store the string; actual signing is done via near-cli
  return {
    publicKey: null, // Will be resolved if needed
    privateKey: privateKeyStr,
  };
}

async function waitForAccount(accountId, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await nearRpcCall('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      core.info(`Account ${accountId} confirmed on-chain.`);
      return;
    } catch (err) {
      if (/does not exist|unknown account/i.test(err.message)) {
        await sleep(2000);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Account ${accountId} not confirmed on-chain within ${maxWaitMs}ms`);
}

// ---------------------------------------------------------------------------
// Step 2: Request faucet funding
// ---------------------------------------------------------------------------

async function stepRequestFaucet(inputs) {
  core.startGroup('Step 2: Request Faucet Funding');

  const { accountId, keyPair } = inputs;

  // Check current balance
  let currentBalance = '0';
  try {
    const viewResult = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    currentBalance = viewResult.amount;
    core.info(`Current balance: ${formatNear(currentBalance)} NEAR`);
  } catch (err) {
    core.warning(`Could not fetch balance: ${err.message}`);
  }

  const balanceBigInt = BigInt(currentBalance);
  const minimumRequired = BigInt('5000000000000000000000000'); // 5 NEAR

  if (balanceBigInt >= minimumRequired) {
    core.info(`Balance is sufficient (${formatNear(currentBalance)} NEAR). Skipping faucet.`);
    core.endGroup();
    return { accountId, keyPair, balanceBefore: currentBalance, faucetRequested: false };
  }

  core.info(`Balance below minimum. Requesting faucet funding for ${accountId}...`);

  // Try multiple faucet endpoints
  const faucetEndpoints = [
    {
      url: `${NEAR_HELPER_URL}/account`,
      method: 'POST',
      body: { accountId },
      description: 'NEAR Helper faucet',
    },
    {
      url: `https://near-faucet.io/api/faucet/tokens`,
      method: 'POST',
      body: { account_id: accountId, amount: '10' },
      description: 'near-faucet.io',
    },
  ];

  let funded = false;
  for (const endpoint of faucetEndpoints) {
    try {
      core.info(`Trying faucet: ${endpoint.description} at ${endpoint.url}`);
      const resp = await httpPost(
        endpoint.url,
        endpoint.body,
        { 'Content-Type': 'application/json' }
      );

      core.debug(`Faucet response [${resp.statusCode}]: ${resp.body}`);

      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        core.info(`Faucet request accepted by ${endpoint.description}`);
        funded = true;
        break;
      } else {
        core.warning(`Faucet ${endpoint.description} returned ${resp.statusCode}: ${resp.body}`);
      }
    } catch (err) {
      core.warning(`Faucet ${endpoint.description} error: ${err.message}`);
    }
  }

  if (!funded) {
    core.warning(
      'Could not obtain faucet funding automatically. ' +
      'Proceeding with existing balance. Deployment may fail if balance is too low.'
    );
  } else {
    // Wait for balance update
    core.info('Waiting for faucet funds to arrive...');
    await waitForBalanceIncrease(accountId, balanceBigInt, 60000);
  }

  // Fetch new balance
  let newBalance = currentBalance;
  try {
    const viewResult = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    newBalance = viewResult.amount;
    core.info(`Balance after faucet: ${formatNear(newBalance)} NEAR`);
  } catch (err) {
    core.warning(`Could not fetch updated balance: ${err.message}`);
  }

  core.endGroup();

  return {
    accountId,
    keyPair,
    balanceBefore: currentBalance,
    balanceAfter: newBalance,
    faucetRequested: funded,
  };
}

async function waitForBalanceIncrease(accountId, previousBalance, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const viewResult = await nearRpcCall('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      if (BigInt(viewResult.amount) > previousBalance) {
        core.info(`Balance increased to ${formatNear(viewResult.amount)} NEAR`);
        return;
      }
    } catch {
      // ignore transient errors
    }
    await sleep(3000);
  }
  core.warning('Balance did not increase within timeout. Proceeding anyway.');
}

// ---------------------------------------------------------------------------
// Step 3: Build and deploy the contract
// ---------------------------------------------------------------------------

async function stepDeployContract(inputs) {
  core.startGroup('Step 3: Build and Deploy Contract');

  const {
    accountId,
    keyPair,
    contractPath,
    wasmPath,
    buildCommand,
    initFunction,
    initArgs,
    nearCredsDir,
  } = inputs;

  ensureNearCli();

  let resolvedWasmPath = wasmPath;

  // Build contract if a build command is provided and no prebuilt wasm
  if (buildCommand && (!wasmPath || !fs.existsSync(wasmPath))) {
    core.info(`Building contract with: ${buildCommand}`);

    const buildCwd = contractPath || process.cwd();
    core.info(`Build directory: ${buildCwd}`);

    const { stdout, stderr } = runCommand(buildCommand, { cwd: buildCwd });

    if (stdout) core.info(`Build stdout:\n${stdout}`);
    if (stderr) core.info(`Build stderr:\n${stderr}`);

    core.info('Build completed successfully.');

    // Try to locate the wasm file if not explicitly specified
    if (!resolvedWasmPath) {
      resolvedWasmPath = findWasmFile(buildCwd);
      if (!resolvedWasmPath) {
        throw new Error(
          'Build succeeded but could not locate a .wasm file. ' +
          'Please specify the wasm-path input explicitly.'
        );
      }
    }
  } else if (!resolvedWasmPath || !fs.existsSync(resolvedWasmPath)) {
    throw new Error(
      `No wasm file found at path: ${resolvedWasmPath}. ` +
      'Either specify wasm-path or provide a build-command.'
    );
  }

  core.info(`Deploying wasm: ${resolvedWasmPath}`);
  const wasmStat = fs.statSync(resolvedWasmPath);
  core.info(`Wasm file size: ${(wasmStat.size / 1024).toFixed(2)} KB`);

  // Deploy via near-cli
  let deployCmd = `near deploy --accountId ${accountId} --wasmFile ${resolvedWasmPath} --networkId testnet`;

  if (initFunction) {
    deployCmd += ` --initFunction ${initFunction}`;
    if (initArgs) {
      deployCmd += ` --initArgs '${initArgs}'`;
    }
  }

  core.info(`Running: ${deployCmd}`);

  const deployResult = runCommand(deployCmd, {
    env: {
      ...process.env,
      NEAR_ENV: 'testnet',
      HOME: process.env.HOME || '/root',
    },
  });

  core.info(`Deploy stdout:\n${deployResult.stdout}`);
  if (deployResult.stderr) {
    core.info(`Deploy stderr:\n${deployResult.stderr}`);
  }

  // Extract transaction hash from output
  const txHashMatch = deployResult.stdout.match(/Transaction Id ([A-Za-z0-9]+)/);
  const txHash = txHashMatch ? txHashMatch[1] : null;

  if (txHash) {
    core.info(`Deployment transaction: ${EXPLORER_URL}/transactions/${txHash}`);
    core.setOutput('deploy-tx-hash', txHash);
  }

  // Verify deployment by checking code hash
  core.info('Verifying deployment on-chain...');
  await sleep(3000); // Allow finalization

  const viewResult = await nearRpcCall('query', {
    request_type: 'view_account',
    finality: 'final',
    account_