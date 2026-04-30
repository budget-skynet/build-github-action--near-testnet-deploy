async function nearRpcCall(method, params) {
  const body = { jsonrpc: '2.0', id: 'dontcare', method, params };
  const response = await httpsRequest({
    hostname: 'rpc.testnet.near.org',
    port: 443,
    path: '/',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify(body));
  if (!response.json) throw new Error(`RPC error: empty response for ${method}`);
  if (response.json.error) throw new Error(`RPC error [${method}]: ${JSON.stringify(response.json.error)}`);
  return response.json.result;
}

async function requestFaucet(accountId) {
  core.info(`Requesting faucet funding for ${accountId}...`);
  // Primary: near-faucet.io
  try {
    const response = await httpsRequest({
      hostname: 'near-faucet.io',
      port: 443,
      path: '/api/faucet',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ account_id: accountId }));
    if (response.status === 200 || response.status === 201) {
      core.info(`Faucet funding response: ${response.body}`);
      return true;
    }
    core.warning(`Faucet primary returned status ${response.status}: ${response.body}`);
  } catch (err) {
    core.warning(`Faucet primary failed: ${err.message}`);
  }

  // Fallback: helper.testnet.near.org
  try {
    const response = await httpsRequest({
      hostname: 'helper.testnet.near.org',
      port: 443,
      path: '/account',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ newAccountId: accountId, newAccountPublicKey: 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MtwoX2TGUbMWc' }));
    if (response.status === 200 || response.status === 201) {
      core.info(`Helper faucet response: ${response.body}`);
      return true;
    }
    core.warning(`Helper faucet returned status ${response.status}: ${response.body}`);
  } catch (err) {
    core.warning(`Helper faucet failed: ${err.message}`);
  }

  return false;
}

// ─── NEAR CLI helpers ────────────────────────────────────────────────────────

function run_cmd(cmd, opts = {}) {
  core.debug(`$ ${cmd}`);
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: opts.silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 120000
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '') + (err.stderr || ''),
      error: err.message
    };
  }
}

function nearCLIAvailable() {
  const result = run_cmd('near --version', { silent: true });
  if (result.success) {
    core.info(`NEAR CLI available: ${result.output}`);
    return true;
  }
  return false;
}

function installNearCLI() {
  core.info('Installing NEAR CLI...');
  const result = run_cmd('npm install -g near-cli', { timeout: 180000 });
  if (!result.success) throw new Error(`Failed to install NEAR CLI: ${result.output}`);
  core.info('NEAR CLI installed successfully.');
}

function nearCliEnv(privateKey) {
  return {
    NEAR_ENV: 'testnet',
    NEAR_CLI_TESTNET_KEY_PATH: '',
    NEAR_HELPER_ACCOUNT: 'testnet',
    NEAR_HELPER_URL: 'https://helper.testnet.near.org',
    NEAR_NODE_URL: 'https://rpc.testnet.near.org',
    NEAR_WALLET_URL: 'https://wallet.testnet.near.org',
    NEAR_EXPLORER_URL: 'https://explorer.testnet.near.org'
  };
}

// ─── Credential file helper ──────────────────────────────────────────────────

function writeCredentials(accountId, privateKey) {
  // near-cli expects credentials in ~/.near-credentials/testnet/<account>.json
  const credDir = path.join(os.homedir(), '.near-credentials', 'testnet');
  fs.mkdirSync(credDir, { recursive: true });

  // Parse key format – accept raw ed25519 hex or "ed25519:<base58>" format
  let keyType = 'ed25519';
  let keyValue = privateKey;
  if (privateKey.includes(':')) {
    const parts = privateKey.split(':');
    keyType = parts[0];
    keyValue = parts[1];
  }

  // Derive public key using near-api-js / fallback placeholder (near-cli handles the real derive)
  // We store a credential file in the format near-cli understands
  const credFile = path.join(credDir, `${accountId}.json`);
  const cred = {
    account_id: accountId,
    public_key: `${keyType}:${keyValue}`,  // near-cli will use private_key for signing
    private_key: `${keyType}:${keyValue}`
  };
  fs.writeFileSync(credFile, JSON.stringify(cred, null, 2), { mode: 0o600 });
  core.info(`Credentials written to ${credFile}`);
  return credFile;
}

// ─── Step 1: Auto-create testnet account if needed ───────────────────────────

async function stepEnsureAccount(accountId, privateKey) {
  core.startGroup('Step 1: Ensure testnet account exists');
  try {
    core.info(`Checking if account ${accountId} exists on testnet...`);

    let accountExists = false;
    try {
      const result = await nearRpcCall('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId
      });
      if (result && result.amount !== undefined) {
        accountExists = true;
        core.info(`Account ${accountId} exists. Balance: ${result.amount} yoctoNEAR`);
        core.setOutput('account_balance', result.amount);
        core.setOutput('account_existed', 'true');
      }
    } catch (rpcErr) {
      if (rpcErr.message.includes('does not exist') || rpcErr.message.includes('unknown account')) {
        accountExists = false;
        core.info(`Account ${accountId} does not exist yet.`);
      } else {
        core.warning(`RPC query error (will try to proceed): ${rpcErr.message}`);
        accountExists = false;
      }
    }

    if (!accountExists) {
      core.info(`Creating account ${accountId} via testnet helper...`);

      // Extract public key from private key for account creation
      let publicKeyPart = privateKey;
      if (privateKey.includes(':')) publicKeyPart = privateKey.split(':')[1];

      const createPayload = {
        newAccountId: accountId,
        newAccountPublicKey: `ed25519:${publicKeyPart}`
      };

      const response = await httpsRequest({
        hostname: 'helper.testnet.near.org',
        port: 443,
        path: '/account',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify(createPayload));

      if (response.status === 200 || response.status === 201) {
        core.info(`Account ${accountId} created successfully via helper.`);
        core.setOutput('account_existed', 'false');
        core.setOutput('account_created', 'true');
      } else {
        core.warning(`Helper account creation returned ${response.status}: ${response.body}`);
        core.info('Account may already exist or creation failed – proceeding with credential setup.');
      }
    }

    // Always write credentials so near-cli can sign transactions
    writeCredentials(accountId, privateKey);
    core.info('Account setup complete.');
    return { accountId, accountExists };
  } finally {
    core.endGroup();
  }
}

// ─── Step 2: Request faucet funding ─────────────────────────────────────────

async function stepFaucetFunding(accountId, faucetEnabled) {
  core.startGroup('Step 2: Faucet funding');
  try {
    if (faucetEnabled !== 'true') {
      core.info('Faucet funding disabled – skipping.');
      core.setOutput('faucet_funded', 'false');
      return { funded: false };
    }

    const funded = await requestFaucet(accountId);
    if (funded) {
      core.info('Faucet funding request submitted successfully.');
      core.setOutput('faucet_funded', 'true');

      // Brief wait for funding to land
      core.info('Waiting 5s for faucet transaction to finalize...');
      await new Promise(r => setTimeout(r, 5000));

      // Verify balance
      try {
        const result = await nearRpcCall('query', {
          request_type: 'view_account',
          finality: 'final',
          account_id: accountId
        });
        if (result && result.amount) {
          core.info(`Post-faucet balance: ${result.amount} yoctoNEAR`);
          core.setOutput('account_balance', result.amount);
        }
      } catch (e) {
        core.warning(`Could not verify balance after faucet: ${e.message}`);
      }
    } else {
      core.warning('Faucet funding failed or unavailable – proceeding anyway.');
      core.setOutput('faucet_funded', 'false');
    }

    return { funded };
  } finally {
    core.endGroup();
  }
}

// ─── Step 3: Build + deploy contract ─────────────────────────────────────────

async function stepDeployContract(accountId, contractPath, privateKey) {
  core.startGroup('Step 3: Build & deploy contract');
  try {
    const absContractPath = path.resolve(contractPath);
    if (!fs.existsSync(absContractPath)) {
      throw new Error(`Contract path does not exist: ${absContractPath}`);
    }

    let wasmPath = null;

    // Determine if the path is a WASM file or a directory to build
    const stat = fs.statSync(absContractPath);
    if (stat.isFile() && absContractPath.endsWith('.wasm')) {
      core.info(`Using pre-compiled WASM: ${absContractPath}`);
      wasmPath = absContractPath;
    } else if (stat.isDirectory()) {
      core.info(`Building contract in directory: ${absContractPath}`);
      wasmPath = buildContract(absContractPath);
    } else {
      throw new Error(`contract_path must be a .wasm file or a directory. Got: ${absContractPath}`);
    }

    if (!wasmPath || !fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found after build step: ${wasmPath}`);
    }

    const wasmSize = fs.statSync(wasmPath).size;
    core.info(`WASM file: ${wasmPath} (${(wasmSize / 1024).toFixed(2)} KB)`);
    core.setOutput('wasm_path', wasmPath);
    core.setOutput('wasm_size_bytes', String(wasmSize));

    // Ensure NEAR CLI is available
    if (!nearCLIAvailable()) installNearCLI();

    // Deploy
    core.info(`Deploying ${wasmPath} to account ${accountId}...`);
    const deployEnv = { ...process.env, NEAR_ENV: 'testnet' };

    const deployResult = run_cmd(
      `near deploy --accountId ${accountId} --wasmFile ${wasmPath} --networkId testnet`,
      { env: deployEnv, timeout: 180000 }
    );

    if (!deployResult.success) {
      // Try alternative deploy command format (near-cli v3+)
      core.warning(`Standard deploy failed, trying alternate syntax...`);
      const altResult = run_cmd(
        `near deploy ${accountId} ${wasmPath} --networkId testnet`,
        { env: deployEnv, timeout: 180000 }
      );
      if (!altResult.success) {
        throw new Error(`Contract deployment failed.\nAttempt 1: ${deployResult.output}\nAttempt 2: ${altResult.output}`);
      }
      core.info(`Deploy output:\n${altResult.output}`);
    } else {
      core.info(`Deploy output:\n${deployResult.output}`);
    }

    // Extract transaction hash if present
    const txHashMatch = (deployResult.output + '').match(/Transaction\s+Id\s+([A-Za-z0-9]+)/i)
      || (deployResult.output + '').match(/txid[:\s]+([A-Za-z0-9]+)/i);
    if (txHashMatch) {
      core.setOutput('deploy_tx_hash', txHashMatch[1]);
      core.info(`Deploy transaction: ${txHashMatch[1]}`);
    }

    // Verify deployment via RPC
    core.info('Verifying deployment via RPC...');
    await new Promise(r => setTimeout(r, 3000));
    try {
      const accountState = await nearRpcCall('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId
      });
      if (accountState && accountState.code_hash && accountState.code_hash !== '11111111111111111111111111111111') {
        core.info(`Contract deployed. Code hash: ${accountState.code_hash}`);
        core.setOutput('contract_code_hash', accountState.code_hash);
        core.setOutput('deploy_success', 'true');
      } else {
        core.warning('RPC verification: code_hash indicates no contract or not yet finalized.');
      }
    } catch (verifyErr) {
      core.warning(`Deployment verification RPC call failed: ${verifyErr.message}`);
    }

    return { wasmPath, accountId };
  } finally {
    core.endGroup();
  }
}

function buildContract(contractDir) {
  core.info(`Detecting contract type in ${contractDir}...`);

  // ── Rust / NEAR contract (Cargo.toml present)
  if (fs.existsSync(path.join(contractDir, 'Cargo.toml'))) {
    core.info('Rust contract detected. Building with cargo...');

    // Ensure rust + wasm target
    run_cmd('rustup target add wasm32-unknown-unknown', { timeout: 60000 });

    const buildResult = run_cmd(
      'cargo build --target wasm32-unknown-unknown --release',
      { cwd: contractDir, timeout: 600000 }
    );
    if (!buildResult.success) {
      throw new Error(`Rust build failed:\n${buildResult.output}`);
    }

    // Find the .wasm output
    const targetDir = path.join(contractDir, 'target', 'wasm32-unknown-unknown', 'release');
    const wasmFiles = fs.readdirSync(targetDir).filter(f => f.endsWith('.wasm'));
    if (!wasmFiles.length) throw new Error(`No WASM files found in ${targetDir}`);

    // Prefer the non-deps one
    const wasmFile = wasmFiles.find(f => !f.includes('-') && !f.startsWith('lib')) || wasmFiles[0];
    const wasmPath = path.join(targetDir, wasmFile);
    core.info(`Built WASM: ${wasmPath}`);
    return wasmPath;
  }

  // ── AssemblyScript (asconfig.json or package.json with asbuild)
  if (fs.existsSync(path.join(contractDir, 'asconfig.json'))
    || fs.existsSync(path.join(contractDir, 'assembly'))) {
    core.info('AssemblyScript contract detected. Building...');

    if (!run_cmd('npm install', { cwd: contractDir, timeout: 120000 }).success) {
      throw new Error('npm install failed for AssemblyScript contract.');
    }
    const buildResult = run_cmd('npm run build', { cwd: contractDir, timeout: 300000 });
    if (!buildResult.success) {
      throw new Error(`AssemblyScript build failed:\n${buildResult.output}`);
    }

    // Common output paths for AS NEAR contracts
    const candidates = [
      path.join(contractDir, 'build', 'release', 'main.wasm'),
      path.join(contractDir, 'out', 'main.wasm'),
      path.join(contractDir, 'build', 'main.wasm')
    ];
    const wasmPath = candidates.find(p => fs.existsSync(p));
    if (!wasmPath) throw new Error('Could not find AssemblyScript build output WASM.');
    return wasmPath;
  }

  // ── Generic: look for any pre-built .wasm
  const wasmFiles = fs.readdirSync(contractDir).filter(f => f.endsWith('.wasm'));
  if (wasmFiles.length) {
    const wasmPath = path.join(contractDir, wasmFiles[0]);
    core.info(`Found existing WASM: ${wasmPath}`);
    return wasmPath;
  }

  throw new Error(`Cannot determine how to build contract in ${contractDir}. Provide Cargo.toml, asconfig.json, or a .wasm file.`);
}

// ─── Step 4: Run smoke tests ─────────────────────────────────────────────────

async function stepRunSmokeTests(accountId, smokeTestsPath, deployOutput) {
  core.startGroup('Step 4: Run smoke tests');
  const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

  try {
    const absTestPath = path.resolve(smokeTestsPath);

    if (!fs.existsSync(absTestPath)) {
      core.warning(`Smoke test path does not exist: ${absTestPath} – running built-in RPC smoke tests.`);
      const rpcResults = await runBuiltinRpcSmokes(accountId);
      Object.assign(results, rpcResults);
      return results;
    }

    const stat = fs.statSync(absTestPath);
    let testFiles = [];

    if (stat.isFile()) {
      testFiles = [absTestPath];
    } else if (stat.isDirectory()) {
      testFiles = gatherTestFiles(absTestPath);
    }

    if (!testFiles.length) {
      core.warning('No test files found – running built-in RPC smoke tests.');
      const rpcResults = await runBuiltinRpcSmokes(accountId);
      Object.assign(results, rpcResults);
      return results;
    }

    core.info(`Found ${testFiles.length} test file(s): ${testFiles.join(', ')}`);

    // Set CONTRACT_ID env for test files
    const testEnv = {
      ...process.env,
      NEAR_ENV: 'testnet',
      CONTRACT_ID: accountId,
      NEAR_CONTRACT_ID: accountId,
      TESTNET_CONTRACT_ID: accountId
    };

    for (const testFile of testFiles) {
      const testResult = await runSingleTestFile(testFile, testEnv, accountId);
      results.tests.push(testResult);
      if (testResult.status === 'passed') results.passed++;
      else if (testResult.status === 'failed') results.failed++;
      else results.skipped++;
    }

    // Also run built-in RPC smoke tests as baseline
    core.info('Running built-in RPC smoke tests...');
    const rpcResults = await runBuiltinRpcSmokes(accountId);
    results.tests.push(...rpcResults.tests);
    results.passed += rpcResults.passed;
    results.failed += rpcResults.failed;

    return results;
  } finally {
    core.endGroup();
  }
}

function gatherTestFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...gatherTestFiles(full));
    } else if (entry.isFile() && (
      entry.name.endsWith('.test.js') ||
      entry.name.endsWith('.spec.js') ||
      entry.name.endsWith('_test.js') ||
      entry.name.startsWith('test_') ||
      entry.name === 'smoke.js' ||
      entry.name === 'smoke_test.js'
    )) {
      files.push(full);
    }
  }
  return files;
}

async function runSingleTestFile(testFile, testEnv, accountId) {
  core.info(`Running test file: ${testFile}`);
  const ext = path.extname(testFile);
  let cmd;

  if (ext === '.js' || ext === '.mjs') {
    // Check for test runner hints in package.json
    const pkgPath = findPackageJson(path.dirname(testFile));
    const pkg = pkgPath ? JSON.parse(fs.readFileSync(pkgPath, 'utf