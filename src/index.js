async function nearRpcCall(method, params) {
  const payload = {
    jsonrpc: '2.0',
    id: 'near-testnet-deploy',
    method,
    params,
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await httpRequest(NEAR_RPC_URL, payload);
      if (response.error) {
        throw new Error(`RPC error: ${JSON.stringify(response.error)}`);
      }
      return response.result;
    } catch (err) {
      lastError = err;
      core.warning(`RPC attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(`RPC call '${method}' failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

/**
 * Execute a shell command, streaming output to core.info.
 * @param {string} command
 * @param {object} options
 * @returns {string} stdout
 */
function execCommand(command, options = {}) {
  core.info(`$ ${command}`);
  try {
    const result = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      cwd: options.cwd || process.cwd(),
    });
    if (result) {
      core.info(result.trim());
    }
    return result ? result.trim() : '';
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    if (stdout) core.info(stdout);
    if (stderr) core.error(stderr);
    throw new Error(`Command failed: ${command}\n${stderr || err.message}`);
  }
}

/**
 * Execute a NEAR CLI command via shell, injecting credentials.
 * @param {string} nearArgs
 * @param {object} env
 * @returns {string}
 */
function nearCli(nearArgs, env = {}) {
  return execCommand(`near ${nearArgs}`, { env });
}

/**
 * Set up NEAR credentials file for the given account.
 * @param {string} accountId
 * @param {string} privateKey
 */
function setupNearCredentials(accountId, privateKey) {
  core.info(`Setting up NEAR credentials for account: ${accountId}`);

  // Parse the private key — accept both raw ed25519 keys and JSON keystore format
  let secretKey = privateKey.trim();
  let publicKey = '';

  // If key is JSON (keystore format), extract fields
  if (secretKey.startsWith('{')) {
    try {
      const keyObj = JSON.parse(secretKey);
      secretKey = keyObj.private_key || keyObj.secret_key || keyObj.privateKey || secretKey;
      publicKey = keyObj.public_key || keyObj.publicKey || '';
    } catch (e) {
      core.warning('Failed to parse private key as JSON, using as-is');
    }
  }

  // Ensure key has ed25519: prefix
  if (!secretKey.startsWith('ed25519:')) {
    secretKey = `ed25519:${secretKey}`;
  }

  const nearCredentialsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || '/root',
    '.near-credentials',
    TESTNET_NETWORK_ID
  );

  fs.mkdirSync(nearCredentialsDir, { recursive: true });

  const credentialsFile = path.join(nearCredentialsDir, `${accountId}.json`);

  // Build credentials object
  const credentials = {
    account_id: accountId,
    public_key: publicKey || secretKey, // placeholder if public key unknown
    private_key: secretKey,
  };

  // If no public key provided, try to derive it using near-cli keygen
  // For now we store what we have; near-cli will validate on use
  fs.writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  core.info(`Credentials written to ${credentialsFile}`);
  return nearCredentialsDir;
}

/**
 * Check whether a NEAR account exists on testnet.
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
async function accountExists(accountId) {
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return result && result.code_hash !== undefined;
  } catch (err) {
    if (
      err.message.includes('does not exist') ||
      err.message.includes('UNKNOWN_ACCOUNT') ||
      err.message.includes('AccountDoesNotExist')
    ) {
      return false;
    }
    // Re-throw unexpected errors
    throw err;
  }
}

/**
 * Get account balance in NEAR (human-readable).
 * @param {string} accountId
 * @returns {Promise<string>}
 */
async function getAccountBalance(accountId) {
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (result && result.amount) {
      // Convert yoctoNEAR to NEAR
      const yocto = BigInt(result.amount);
      const near = Number(yocto) / 1e24;
      return near.toFixed(4);
    }
    return '0';
  } catch (err) {
    core.warning(`Could not fetch balance for ${accountId}: ${err.message}`);
    return 'unknown';
  }
}

/**
 * Request testnet faucet funding for an account.
 * Uses the NEAR testnet helper API.
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
async function requestFaucetFunding(accountId) {
  core.info(`Requesting faucet funding for account: ${accountId}`);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // NEAR testnet helper /account endpoint — creates or funds account
      const result = await httpRequest(
        `${FAUCET_API_URL}/account`,
        { newAccountId: accountId, newAccountPublicKey: '' }
      );
      core.info(`Faucet response: ${JSON.stringify(result)}`);
      return true;
    } catch (err) {
      // The faucet may 400 if account already funded — that's acceptable
      if (
        err.message.includes('400') ||
        err.message.includes('already exists') ||
        err.message.includes('Too Many Requests')
      ) {
        core.warning(`Faucet returned non-fatal response: ${err.message}`);
        return true; // treat as success — account may already be funded
      }
      lastError = err;
      core.warning(`Faucet attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  core.warning(`Faucet funding failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
  return false;
}

/**
 * Locate the WASM file to deploy. Handles:
 *  - Direct path to a .wasm file
 *  - Directory containing a .wasm file (searches recursively in res/ and target/)
 * @param {string} contractPath
 * @returns {string} Absolute path to .wasm file
 */
function resolveWasmPath(contractPath) {
  const absPath = path.resolve(contractPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Contract path does not exist: ${absPath}`);
  }

  const stat = fs.statSync(absPath);

  if (stat.isFile()) {
    if (!absPath.endsWith('.wasm')) {
      throw new Error(`Contract path is a file but not a .wasm file: ${absPath}`);
    }
    return absPath;
  }

  if (stat.isDirectory()) {
    // Search common output directories
    const searchDirs = [
      path.join(absPath, 'res'),
      path.join(absPath, 'out'),
      path.join(absPath, 'build'),
      path.join(absPath, 'target', 'wasm32-unknown-unknown', 'release'),
      path.join(absPath, 'target', 'near'),
      absPath,
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wasm'));
      if (files.length > 0) {
        const wasmFile = path.join(dir, files[0]);
        core.info(`Found WASM file: ${wasmFile}`);
        return wasmFile;
      }
    }

    throw new Error(
      `No .wasm file found in contract directory: ${absPath}. ` +
        'Please compile your contract first or provide a direct path to the .wasm file.'
    );
  }

  throw new Error(`Invalid contract path: ${absPath}`);
}

/**
 * Get the deployed contract code hash to verify deployment.
 * @param {string} accountId
 * @returns {Promise<string>}
 */
async function getContractCodeHash(accountId) {
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return result ? result.code_hash : '11111111111111111111111111111111';
  } catch (err) {
    core.warning(`Could not fetch code hash for ${accountId}: ${err.message}`);
    return 'unknown';
  }
}

/**
 * Verify contract deployment by checking the code hash changed from the default.
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
async function verifyContractDeployed(accountId) {
  const codeHash = await getContractCodeHash(accountId);
  const isDeployed = codeHash !== '11111111111111111111111111111111' && codeHash !== 'unknown';
  core.info(`Contract code hash on ${accountId}: ${codeHash}`);
  return isDeployed;
}

/**
 * Run a NEAR view call as a basic smoke test.
 * @param {string} accountId
 * @param {string} methodName
 * @param {object} args
 * @returns {Promise<any>}
 */
async function runViewCall(accountId, methodName, args = {}) {
  core.info(`Running view call: ${accountId}.${methodName}(${JSON.stringify(args)})`);
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString('base64');

  try {
    const result = await nearRpcCall('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: methodName,
      args_base64: argsBase64,
    });

    if (result && result.result) {
      const decoded = Buffer.from(result.result).toString('utf8');
      core.info(`View call result: ${decoded}`);
      return JSON.parse(decoded);
    }
    return null;
  } catch (err) {
    core.warning(`View call ${methodName} failed: ${err.message}`);
    return null;
  }
}

// ─── STEP FUNCTIONS ──────────────────────────────────────────────────────────

/**
 * STEP 1: Auto-create testnet account if it does not exist.
 * @param {string} accountId
 * @param {string} credentialsDir
 * @returns {Promise<{created: boolean, existed: boolean}>}
 */
async function stepEnsureAccount(accountId, credentialsDir) {
  core.startGroup('Step 1: Ensure Testnet Account Exists');

  try {
    core.info(`Checking if account '${accountId}' exists on NEAR testnet...`);

    const exists = await accountExists(accountId);

    if (exists) {
      core.info(`✅ Account '${accountId}' already exists on testnet.`);
      const balance = await getAccountBalance(accountId);
      core.info(`   Current balance: ${balance} NEAR`);
      core.setOutput('account_created', 'false');
      core.setOutput('account_existed', 'true');
      return { created: false, existed: true };
    }

    core.info(`Account '${accountId}' not found. Attempting to create via testnet helper...`);

    // Attempt creation via NEAR testnet helper
    try {
      const createResult = await httpRequest(
        `${FAUCET_API_URL}/account`,
        {
          newAccountId: accountId,
          newAccountPublicKey: 'ed25519:11111111111111111111111111111111', // placeholder
        }
      );
      core.info(`Account creation response: ${JSON.stringify(createResult)}`);
    } catch (helperErr) {
      core.warning(
        `Testnet helper account creation returned: ${helperErr.message}. ` +
          'This may be expected — checking account state again...'
      );
    }

    // Wait for account to propagate
    core.info('Waiting for account propagation...');
    await sleep(5000);

    // Re-check existence
    const nowExists = await accountExists(accountId);

    if (nowExists) {
      core.info(`✅ Account '${accountId}' created successfully.`);
      core.setOutput('account_created', 'true');
      core.setOutput('account_existed', 'false');
      return { created: true, existed: false };
    }

    // If helper creation failed, try near-cli create-account as fallback
    core.info('Attempting account creation via near-cli...');
    try {
      nearCli(
        `create-account ${accountId} --masterAccount testnet --initialBalance ${ACCOUNT_CREATION_DEPOSIT} --networkId ${TESTNET_NETWORK_ID}`
      );
      await sleep(3000);
      core.info(`✅ Account created via near-cli.`);
    } catch (cliErr) {
      core.warning(`near-cli account creation: ${cliErr.message}`);
      // Not fatal — faucet step may fund and implicitly create
    }

    core.setOutput('account_created', 'true');
    core.setOutput('account_existed', 'false');
    return { created: true, existed: false };
  } finally {
    core.endGroup();
  }
}

/**
 * STEP 2: Request faucet funding if enabled.
 * @param {string} accountId
 * @param {boolean} faucetEnabled
 * @returns {Promise<{funded: boolean, skipped: boolean, balanceBefore: string, balanceAfter: string}>}
 */
async function stepFaucetFunding(accountId, faucetEnabled) {
  core.startGroup('Step 2: Faucet Funding');

  try {
    if (!faucetEnabled) {
      core.info('ℹ️  Faucet funding is disabled. Skipping.');
      core.setOutput('faucet_funded', 'false');
      core.setOutput('faucet_skipped', 'true');
      return { funded: false, skipped: true, balanceBefore: 'N/A', balanceAfter: 'N/A' };
    }

    const balanceBefore = await getAccountBalance(accountId);
    core.info(`Balance before faucet: ${balanceBefore} NEAR`);

    // Check if balance is already sufficient (> 5 NEAR)
    const balanceNum = parseFloat(balanceBefore);
    if (!isNaN(balanceNum) && balanceNum > 5) {
      core.info(`✅ Account has sufficient balance (${balanceBefore} NEAR). Skipping faucet.`);
      core.setOutput('faucet_funded', 'false');
      core.setOutput('faucet_skipped', 'true');
      return { funded: false, skipped: true, balanceBefore, balanceAfter: balanceBefore };
    }

    core.info(`Requesting ${FAUCET_AMOUNT} NEAR from testnet faucet for account: ${accountId}`);

    const funded = await requestFaucetFunding(accountId);

    if (funded) {
      // Wait for funds to arrive
      core.info('Waiting for faucet transaction to finalize...');
      await sleep(5000);
    }

    const balanceAfter = await getAccountBalance(accountId);
    core.info(`Balance after faucet: ${balanceAfter} NEAR`);

    if (funded) {
      core.info(`✅ Faucet funding completed. Balance: ${balanceAfter} NEAR`);
    } else {
      core.warning('⚠️  Faucet funding may not have succeeded. Check account balance manually.');
    }

    core.setOutput('faucet_funded', funded ? 'true' : 'false');
    core.setOutput('faucet_skipped', 'false');

    return { funded, skipped: false, balanceBefore, balanceAfter };
  } finally {
    core.endGroup();
  }
}

/**
 * STEP 3: Deploy the contract to testnet.
 * @param {string} accountId
 * @param {string} contractPath
 * @param {string} credentialsDir
 * @returns {Promise<{wasmPath: string, codeHashBefore: string, codeHashAfter: string, txHash: string}>}
 */
async function stepDeployContract(accountId, contractPath, credentialsDir) {
  core.startGroup('Step 3: Deploy Contract');

  try {
    // Resolve the WASM file
    core.info(`Resolving contract path: ${contractPath}`);
    const wasmPath = resolveWasmPath(contractPath);
    const wasmSize = fs.statSync(wasmPath).size;
    core.info(`WASM file: ${wasmPath} (${(wasmSize / 1024).toFixed(2)} KB)`);

    if (wasmSize > 4 * 1024 * 1024) {
      throw new Error(
        `WASM file size (${(wasmSize / 1024).toFixed(2)} KB) exceeds NEAR's 4MB limit`
      );
    }

    // Get code hash before deployment
    const codeHashBefore = await getContractCodeHash(accountId);
    core.info(`Code hash before deploy: ${codeHashBefore}`);

    // Deploy via near-cli
    core.info(`Deploying ${wasmPath} to account ${accountId}...`);

    let deployOutput = '';
    let txHash = '';

    try {
      deployOutput = nearCli(
        `deploy --accountId ${accountId} --wasmFile "${wasmPath}" --networkId ${TESTNET_NETWORK_ID}`,
        {
          NEAR_ENV: TESTNET_NETWORK_ID,
          HOME: process.env.HOME || '/root',
        }
      );
      core.info(`Deploy output: ${deployOutput}`);

      // Extract transaction hash from output
      const txHashMatch = deployOutput.match(/Transaction Id ([A-Za-z0-9]+)/