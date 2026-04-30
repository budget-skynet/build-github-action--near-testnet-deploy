async function nearRpcCall(networkId, method, params) {
  const rpcUrls = {
    testnet: 'https://rpc.testnet.near.org',
    mainnet: 'https://rpc.mainnet.near.org',
  };
  const rpcUrl = rpcUrls[networkId] || rpcUrls.testnet;

  const body = {
    jsonrpc: '2.0',
    id: 'dontcare',
    method,
    params,
  };

  try {
    const response = await httpRequest(rpcUrl, { method: 'POST' }, body);
    return response.data;
  } catch (err) {
    throw new Error(`RPC call failed (${method}): ${err.message}`);
  }
}

// ─── Step 1: Setup credentials ───────────────────────────────────────────────

async function setupCredentials(accountId, nearCredentials, networkId) {
  core.startGroup('Step 1 — Setup credentials');
  core.info(`Setting up NEAR credentials for account: ${accountId}`);

  // Decode base64 credentials
  let credentialsJson;
  try {
    const decoded = Buffer.from(nearCredentials, 'base64').toString('utf8');
    credentialsJson = JSON.parse(decoded);
    core.info('Credentials decoded and parsed successfully.');
  } catch (err) {
    throw new Error(`Failed to decode/parse near_credentials: ${err.message}`);
  }

  // Ensure credentials contain required fields
  if (!credentialsJson.private_key && !credentialsJson.secret_key) {
    throw new Error('Credentials JSON must contain "private_key" or "secret_key".');
  }

  // Normalize key field to what NEAR CLI expects
  const normalizedCreds = {
    account_id: credentialsJson.account_id || accountId,
    public_key: credentialsJson.public_key,
    private_key: credentialsJson.private_key || credentialsJson.secret_key,
  };

  // Write credentials to NEAR keystore directory
  const nearDir = path.join(os.homedir(), '.near-credentials', networkId);
  fs.mkdirSync(nearDir, { recursive: true });

  const credPath = path.join(nearDir, `${accountId}.json`);
  fs.writeFileSync(credPath, JSON.stringify(normalizedCreds, null, 2), { mode: 0o600 });
  core.info(`Credentials written to: ${credPath}`);

  core.endGroup();
  return { credPath, publicKey: normalizedCreds.public_key };
}

// ─── Step 2: Check / create testnet account ──────────────────────────────────

async function ensureAccountExists(accountId, networkId) {
  core.startGroup('Step 2 — Check / create testnet account');
  core.info(`Checking if account exists: ${accountId}`);

  const response = await nearRpcCall(networkId, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });

  if (response && response.result && response.result.code_hash !== undefined) {
    const balanceYocto = BigInt(response.result.amount || '0');
    const balanceNear = Number(balanceYocto) / 1e24;
    core.info(`Account exists. Balance: ${balanceNear.toFixed(4)} NEAR`);
    core.endGroup();
    return { created: false, balance: balanceNear };
  }

  // Account does not exist — attempt to create it via NEAR CLI
  core.info(`Account ${accountId} not found. Attempting to create via testnet helper...`);

  // Try creating via near-cli
  const nearCliCheck = run_command('near --version', { silent: true });
  if (!nearCliCheck.success) {
    core.info('near-cli not found, attempting to install...');
    const installResult = run_command('npm install -g near-cli', { timeout: 120000 });
    if (!installResult.success) {
      throw new Error(`Failed to install near-cli: ${installResult.stderr}`);
    }
    core.info('near-cli installed successfully.');
  }

  // Use near-cli to create account (testnet only)
  if (networkId !== 'testnet') {
    throw new Error(`Account ${accountId} does not exist and auto-creation is only supported on testnet.`);
  }

  // For testnet, attempt creation via the wallet helper API
  const masterAccount = accountId.endsWith('.testnet') ? 'testnet' : null;
  if (!masterAccount) {
    throw new Error(`Account ${accountId} does not exist. For testnet auto-creation, account must end in .testnet`);
  }

  core.info('Creating new testnet sub-account via near-cli...');
  const createResult = run_command(
    `near create-account ${accountId} --masterAccount ${masterAccount} --networkId ${networkId}`,
    { env: { NEAR_ENV: networkId } }
  );

  if (!createResult.success) {
    core.warning(`near-cli create-account failed (${createResult.stderr}). Will rely on faucet funding for implicit account.`);
    core.endGroup();
    return { created: false, balance: 0, needsFaucet: true };
  }

  core.info(`Account ${accountId} created successfully.`);
  core.endGroup();
  return { created: true, balance: 0 };
}

// ─── Step 3: Request faucet funding ─────────────────────────────────────────

async function requestFaucetFunding(accountId, networkId, faucetEnabled) {
  core.startGroup('Step 3 — Faucet funding');

  if (faucetEnabled !== 'true' && faucetEnabled !== true) {
    core.info('Faucet funding is disabled. Skipping.');
    core.endGroup();
    return { funded: false, skipped: true };
  }

  if (networkId !== 'testnet') {
    core.info(`Faucet is only available on testnet. Skipping for network: ${networkId}`);
    core.endGroup();
    return { funded: false, skipped: true };
  }

  core.info(`Requesting faucet funding for: ${accountId}`);

  // NEAR testnet faucet endpoint
  const faucetUrl = 'https://helper.nearprotocol.com/account';
  const nearPageFaucet = 'https://near-faucet.io/api/faucet/tokens';

  // Try near-faucet.io first
  let funded = false;
  try {
    core.info('Trying near-faucet.io...');
    const resp = await httpRequest(
      nearPageFaucet,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 20000,
      },
      { account_id: accountId, network: networkId }
    );

    if (resp.status === 200 || resp.status === 201) {
      core.info('Faucet funding request accepted via near-faucet.io.');
      funded = true;
    } else {
      core.warning(`near-faucet.io returned status ${resp.status}: ${resp.raw}`);
    }
  } catch (err) {
    core.warning(`near-faucet.io request failed: ${err.message}`);
  }

  // Fallback: nearprotocol helper
  if (!funded) {
    try {
      core.info('Trying nearprotocol helper faucet...');
      const resp = await httpRequest(
        faucetUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 20000,
        },
        { newAccountId: accountId, newAccountPublicKey: 'ed25519:11111111111111111111111111111111111111111111' }
      );

      if (resp.status === 200 || resp.status === 201) {
        core.info('Faucet funding request accepted via nearprotocol helper.');
        funded = true;
      } else {
        core.warning(`nearprotocol helper returned status ${resp.status}: ${resp.raw}`);
      }
    } catch (err) {
      core.warning(`nearprotocol helper request failed: ${err.message}`);
    }
  }

  // Fallback: near-cli faucet for testnet
  if (!funded) {
    core.info('Trying near-cli testnet implicit faucet...');
    const cliResult = run_command(
      `npx near-cli tokens ${accountId} send-near testnet 10 --networkId testnet 2>/dev/null || true`,
      { silent: true, env: { NEAR_ENV: networkId } }
    );
    core.info(cliResult.output || 'CLI faucet attempt complete.');
  }

  if (funded) {
    core.info('Waiting 5 seconds for faucet transaction to finalize...');
    await sleep(5000);

    // Verify balance
    const response = await nearRpcCall(networkId, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });

    if (response && response.result) {
      const balanceYocto = BigInt(response.result.amount || '0');
      const balanceNear = Number(balanceYocto) / 1e24;
      core.info(`Account balance after faucet: ${balanceNear.toFixed(4)} NEAR`);
      core.endGroup();
      return { funded: true, balance: balanceNear };
    }
  }

  core.warning('Could not confirm faucet funding. Proceeding anyway.');
  core.endGroup();
  return { funded, balance: null };
}

// ─── Step 4: Build contract ───────────────────────────────────────────────────

async function buildContract(contractPath) {
  core.startGroup('Step 4 — Build contract');
  core.info(`Building contract at path: ${contractPath}`);

  if (!fs.existsSync(contractPath)) {
    throw new Error(`contract_path does not exist: ${contractPath}`);
  }

  const stat = fs.statSync(contractPath);
  const isDirectory = stat.isDirectory();
  let wasmPath = null;

  if (!isDirectory) {
    // It's a file — check if already a .wasm
    if (contractPath.endsWith('.wasm')) {
      core.info('Contract path is already a .wasm file. Skipping build.');
      wasmPath = contractPath;
      core.endGroup();
      return { wasmPath, built: false };
    }
    throw new Error(`contract_path must be a directory or a .wasm file. Got: ${contractPath}`);
  }

  const contractDir = contractPath;

  // Detect project type
  const hasCargoToml = fs.existsSync(path.join(contractDir, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(contractDir, 'package.json'));
  const hasMakefile = fs.existsSync(path.join(contractDir, 'Makefile'));

  if (hasCargoToml) {
    core.info('Detected Rust/NEAR contract (Cargo.toml found).');

    // Ensure Rust wasm target is available
    const rustupCheck = run_command('rustup target list --installed', { silent: true });
    if (rustupCheck.success && !rustupCheck.output.includes('wasm32-unknown-unknown')) {
      core.info('Adding wasm32-unknown-unknown target...');
      const addTarget = run_command('rustup target add wasm32-unknown-unknown');
      if (!addTarget.success) {
        throw new Error(`Failed to add wasm target: ${addTarget.stderr}`);
      }
    }

    // Check for cargo-near
    const cargoNearCheck = run_command('cargo near --version', { silent: true });

    if (hasMakefile) {
      core.info('Makefile found, running make...');
      const makeResult = run_command('make', { cwd: contractDir, timeout: 600000 });
      if (!makeResult.success) {
        core.warning(`make failed: ${makeResult.stderr}. Falling back to cargo build.`);
      } else {
        core.info('make succeeded.');
      }
    }

    // Build with cargo
    core.info('Running cargo build --release --target wasm32-unknown-unknown...');
    const buildResult = run_command(
      'cargo build --release --target wasm32-unknown-unknown',
      { cwd: contractDir, timeout: 600000 }
    );

    if (!buildResult.success) {
      throw new Error(`Cargo build failed:\n${buildResult.stderr}`);
    }

    // Find the wasm file
    const targetDir = path.join(contractDir, 'target', 'wasm32-unknown-unknown', 'release');
    const wasmFiles = fs.existsSync(targetDir)
      ? fs.readdirSync(targetDir).filter((f) => f.endsWith('.wasm'))
      : [];

    if (wasmFiles.length === 0) {
      throw new Error(`No .wasm file found in ${targetDir} after build.`);
    }

    wasmPath = path.join(targetDir, wasmFiles[0]);
    core.info(`Build complete. WASM: ${wasmPath}`);

  } else if (hasPackageJson) {
    core.info('Detected JavaScript/AssemblyScript contract (package.json found).');

    // Install dependencies
    core.info('Running npm install...');
    const installResult = run_command('npm install', { cwd: contractDir, timeout: 300000 });
    if (!installResult.success) {
      throw new Error(`npm install failed: ${installResult.stderr}`);
    }

    // Check for build script
    const pkgJson = JSON.parse(fs.readFileSync(path.join(contractDir, 'package.json'), 'utf8'));
    const hasBuildScript = pkgJson.scripts && pkgJson.scripts.build;

    if (hasBuildScript) {
      core.info('Running npm run build...');
      const buildResult = run_command('npm run build', { cwd: contractDir, timeout: 300000 });
      if (!buildResult.success) {
        throw new Error(`npm run build failed: ${buildResult.stderr}`);
      }
    }

    // Find wasm file
    const searchDirs = ['build', 'out', 'res', '.'];
    for (const dir of searchDirs) {
      const searchPath = path.join(contractDir, dir);
      if (fs.existsSync(searchPath)) {
        const wasmFiles = fs.readdirSync(searchPath).filter((f) => f.endsWith('.wasm'));
        if (wasmFiles.length > 0) {
          wasmPath = path.join(searchPath, wasmFiles[0]);
          break;
        }
      }
    }

    if (!wasmPath) {
      throw new Error('No .wasm file found after JavaScript/AssemblyScript build.');
    }

    core.info(`Build complete. WASM: ${wasmPath}`);
  } else {
    // Search for an existing wasm file in the directory
    const wasmFiles = fs.readdirSync(contractDir).filter((f) => f.endsWith('.wasm'));
    if (wasmFiles.length > 0) {
      wasmPath = path.join(contractDir, wasmFiles[0]);
      core.info(`Found pre-built WASM: ${wasmPath}`);
    } else {
      throw new Error(
        `Cannot determine build system for contract at ${contractDir}. ` +
        'Expected Cargo.toml, package.json, or a pre-built .wasm file.'
      );
    }
  }

  const wasmSize = fs.statSync(wasmPath).size;
  core.info(`WASM file size: ${(wasmSize / 1024).toFixed(2)} KB`);

  core.endGroup();
  return { wasmPath, built: true, wasmSize };
}

// ─── Step 5: Deploy contract ─────────────────────────────────────────────────

async function deployContract(accountId, wasmPath, networkId) {
  core.startGroup('Step 5 — Deploy contract');
  core.info(`Deploying ${wasmPath} to account ${accountId} on ${networkId}`);

  // Ensure near-cli is available
  const nearCliVersion = run_command('near --version', { silent: true });
  if (!nearCliVersion.success) {
    core.info('Installing near-cli...');
    const installResult = run_command('npm install -g near-cli', { timeout: 120000 });
    if (!installResult.success) {
      throw new Error(`Failed to install near-cli: ${installResult.stderr}`);
    }
  }
  core.info(`near-cli available: ${nearCliVersion.output || 'installed'}`);

  // Deploy using near-cli
  const deployCmd = `near deploy --accountId ${accountId} --wasmFile ${wasmPath} --networkId ${networkId}`;
  core.info(`Running: ${deployCmd}`);

  const deployResult = run_command(deployCmd, {
    env: { NEAR_ENV: networkId },
    timeout: 120000,
  });

  if (!deployResult.success) {
    // Try alternative near-cli v2 syntax
    core.warning(`near deploy failed, trying near-cli v2 syntax...`);
    const deployV2Cmd = `near contract deploy ${accountId} use-file ${wasmPath} without-init-call network-config ${networkId} sign-with-keychain send`;
    const deployV2Result = run_command(deployV2Cmd, {
      env: { NEAR_ENV: networkId },
      timeout: 120000,
    });

    if (!deployV2Result.success) {
      throw new Error(
        `Deployment failed.\n` +
        `near-cli v1 error: ${deployResult.stderr}\n` +
        `near-cli v2 error: ${deployV2Result.stderr}`
      );
    }
    core.info('Deployment succeeded (near-cli v2 syntax).');
    core.info(deployV2Result.output);
  } else {
    core.info('Deployment succeeded.');
    core.info(deployResult.output);
  }

  // Wait for deployment to finalize
  core.info('Waiting 3 seconds for deployment to finalize...');
  await sleep(3000);

  // Verify deployment via RPC
  core.info('Verifying deployment via RPC...');
  const verifyResponse = await nearRpcCall(networkId, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });

  let codeHash = 'unknown';
  if (verifyResponse && verifyResponse.result) {
    codeHash = verifyResponse.result.code_hash;
    if (codeHash === '11111111111111111111111111111111') {
      throw new Error('Deployment verification failed: code_hash is still the empty hash. Contract was not deployed.');
    }
    core.info(`Deployment verified! code_hash: ${codeHash}`);
  } else {
    core.warning('Could not verify deployment via RPC. Assuming success based on CLI output.');
  }

  core.endGroup();
  return { deployed: true, codeHash, wasmPath };
}

// ─── Step 6: Run smoke tests ─────────────────────────────────────────────────

async function runSmokeTests(accountId, networkId, testCommand, contractPath) {
  core.startGroup('Step 6 — Smoke tests');
  core.info(`Running smoke tests with command: "${testCommand}"`);

  // Determine working directory for tests
  let testCwd = process.cwd();
  if (fs.existsSync(contractPath) && fs.statSync(contractPath).isDirectory()) {
    testCwd = contractPath;
  } else if (fs.existsSync(contractPath)) {
    testCwd = path.dirname(contractPath);
  }

  core.info(`Test working directory: ${testCwd}`);

  // Set NEAR-related environment variables for tests