async function nearRpcCall(method, params) {
  const rpcUrl = 'https://rpc.testnet.near.org';
  const payload = {
    jsonrpc: '2.0',
    id: 'dontcare',
    method,
    params,
  };

  const response = await httpRequest(
    rpcUrl,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    payload
  );

  const parsed = JSON.parse(response.body);
  if (parsed.error) {
    throw new Error(`RPC error (${method}): ${JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

// ---------------------------------------------------------------------------
// Step 1: Check / auto-create testnet account
// ---------------------------------------------------------------------------

async function checkOrCreateAccount(accountId, privateKey) {
  core.startGroup('Step 1 — Check / create testnet account');

  let accountExists = false;

  try {
    core.info(`Checking whether account "${accountId}" exists on testnet…`);
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    core.info(`Account found. Balance: ${result.amount} yoctoNEAR`);
    accountExists = true;
  } catch (err) {
    if (err.message.includes('does not exist') || err.message.includes('UNKNOWN_ACCOUNT')) {
      core.info(`Account "${accountId}" does not exist yet — will create via helper contract.`);
      accountExists = false;
    } else {
      throw err;
    }
  }

  if (!accountExists) {
    // Use NEAR testnet helper to create the account
    const helperUrl = `https://helper.testnet.near.org/account`;

    // Derive public key from private key using near-api-js style
    // We rely on the near CLI being available (installed in a later step if needed)
    // For account creation we POST to the testnet helper
    const publicKey = derivePublicKeyFromPrivate(privateKey);
    core.info(`Derived public key: ${publicKey}`);

    const createPayload = {
      newAccountId: accountId,
      newAccountPublicKey: publicKey,
    };

    core.info(`Sending account-creation request to NEAR testnet helper…`);
    const response = await httpRequest(
      helperUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      createPayload
    );

    if (response.statusCode !== 200) {
      throw new Error(
        `Account creation failed (HTTP ${response.statusCode}): ${response.body}`
      );
    }

    core.info(`Account "${accountId}" created successfully.`);
    accountExists = true;

    // Wait a few seconds for the account to be indexed
    await sleep(4000);

    // Verify it now exists
    await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    core.info(`Account creation confirmed on-chain.`);
  }

  core.endGroup();
  return { accountId, accountExists: true };
}

// ---------------------------------------------------------------------------
// Step 2: Request faucet funding
// ---------------------------------------------------------------------------

async function requestFaucetFunding(accountId, faucetEnabled) {
  core.startGroup('Step 2 — Faucet funding');

  if (!faucetEnabled) {
    core.info('Faucet disabled — skipping funding step.');
    core.endGroup();
    return { funded: false, skipped: true };
  }

  // Check current balance first
  let balanceBefore;
  try {
    const accountState = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    balanceBefore = BigInt(accountState.amount);
    core.info(`Balance before faucet: ${formatNear(balanceBefore)} NEAR`);
  } catch (err) {
    core.warning(`Could not fetch pre-faucet balance: ${err.message}`);
    balanceBefore = BigInt(0);
  }

  // Minimum balance required: 5 NEAR (in yoctoNEAR)
  const minBalance = BigInt('5000000000000000000000000'); // 5 NEAR

  if (balanceBefore >= minBalance) {
    core.info(`Balance is sufficient (${formatNear(balanceBefore)} NEAR ≥ 5 NEAR). Skipping faucet.`);
    core.endGroup();
    return { funded: false, skipped: true, balanceBefore: balanceBefore.toString() };
  }

  core.info(`Balance below 5 NEAR — requesting faucet funding for "${accountId}"…`);

  // NEAR testnet faucet via helper
  const faucetUrl = `https://helper.testnet.near.org/account/${accountId}/faucet`;

  let funded = false;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      core.info(`Faucet request attempt ${attempt}/3…`);
      const response = await httpRequest(
        faucetUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        {}
      );

      if (response.statusCode === 200 || response.statusCode === 201) {
        core.info(`Faucet responded with HTTP ${response.statusCode}.`);
        funded = true;
        break;
      } else if (response.statusCode === 429) {
        core.warning(`Rate-limited by faucet (attempt ${attempt}). Waiting 10s…`);
        await sleep(10000);
      } else {
        core.warning(`Faucet HTTP ${response.statusCode}: ${response.body}`);
        lastError = response.body;
      }
    } catch (err) {
      core.warning(`Faucet request error (attempt ${attempt}): ${err.message}`);
      lastError = err.message;
      await sleep(5000);
    }
  }

  if (!funded) {
    core.warning(`Could not get faucet funding after 3 attempts: ${lastError}`);
    core.warning('Proceeding with existing balance — deployment may fail if balance is too low.');
    core.endGroup();
    return { funded: false, skipped: false, error: lastError };
  }

  // Wait for balance to update
  core.info('Waiting 8s for faucet transaction to be indexed…');
  await sleep(8000);

  let balanceAfter = BigInt(0);
  try {
    const accountStateAfter = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    balanceAfter = BigInt(accountStateAfter.amount);
    core.info(`Balance after faucet: ${formatNear(balanceAfter)} NEAR`);
  } catch (err) {
    core.warning(`Could not fetch post-faucet balance: ${err.message}`);
  }

  core.endGroup();
  return {
    funded: true,
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
  };
}

// ---------------------------------------------------------------------------
// Step 3: Build & deploy the contract
// ---------------------------------------------------------------------------

async function buildAndDeployContract(contractPath, accountId, privateKey) {
  core.startGroup('Step 3 — Build & deploy contract');

  const absContractPath = path.resolve(contractPath);
  if (!fs.existsSync(absContractPath)) {
    throw new Error(`Contract path does not exist: ${absContractPath}`);
  }

  core.info(`Contract source: ${absContractPath}`);

  // ---- Detect contract type and build ----
  const hasCargoToml = fs.existsSync(path.join(absContractPath, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(absContractPath, 'package.json'));
  const hasAssemblyScript = fs.existsSync(path.join(absContractPath, 'asconfig.json'))
    || fs.existsSync(path.join(absContractPath, 'assembly'));

  let wasmPath;

  if (hasCargoToml) {
    wasmPath = await buildRustContract(absContractPath);
  } else if (hasAssemblyScript || hasPackageJson) {
    wasmPath = await buildAssemblyScriptContract(absContractPath);
  } else {
    // Try to find a pre-built wasm file
    const wasmFiles = findWasmFiles(absContractPath);
    if (wasmFiles.length === 0) {
      throw new Error(
        `No Cargo.toml, package.json, or pre-built .wasm found in ${absContractPath}. ` +
        'Cannot determine how to build this contract.'
      );
    }
    wasmPath = wasmFiles[0];
    core.info(`Using pre-built WASM: ${wasmPath}`);
  }

  core.info(`WASM artifact: ${wasmPath}`);
  const wasmSize = fs.statSync(wasmPath).size;
  core.info(`WASM size: ${(wasmSize / 1024).toFixed(2)} KB`);

  // ---- Set up NEAR credentials for CLI ----
  const credentialsDir = setupNearCredentials(accountId, privateKey);

  // ---- Install near-cli if not present ----
  ensureNearCli();

  // ---- Deploy via near-cli ----
  core.info(`Deploying contract to account "${accountId}"…`);
  const deployResult = execCommand(
    `near deploy --accountId "${accountId}" --wasmFile "${wasmPath}" --networkId testnet`,
    {
      env: {
        ...process.env,
        NEAR_ENV: 'testnet',
        HOME: process.env.HOME || '/root',
      },
    }
  );

  core.info('Deploy output:');
  core.info(deployResult.stdout);
  if (deployResult.stderr) {
    core.info(deployResult.stderr);
  }

  // Parse transaction hash from CLI output
  const txHashMatch =
    (deployResult.stdout + deployResult.stderr).match(/Transaction Id ([A-Za-z0-9]+)/);
  const txHash = txHashMatch ? txHashMatch[1] : null;
  if (txHash) {
    core.info(`Deploy transaction hash: ${txHash}`);
    core.setOutput('deploy_tx_hash', txHash);
  }

  // ---- Verify deployment by checking contract code ----
  core.info('Verifying contract deployment on-chain…');
  await sleep(3000);

  let codeHash;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const viewResult = await nearRpcCall('query', {
        request_type: 'view_code',
        finality: 'final',
        account_id: accountId,
      });
      codeHash = viewResult.hash;
      core.info(`✅ Contract deployed. On-chain code hash: ${codeHash}`);
      break;
    } catch (err) {
      if (attempt < 5) {
        core.info(`Waiting for deployment to be indexed (attempt ${attempt}/5)…`);
        await sleep(4000);
      } else {
        throw new Error(`Deployment verification failed after 5 attempts: ${err.message}`);
      }
    }
  }

  // Clean up credentials directory
  cleanupCredentials(credentialsDir);

  core.endGroup();
  return { wasmPath, wasmSize, txHash, codeHash };
}

async function buildRustContract(contractPath) {
  core.info('Detected Rust/WASM contract — building with cargo…');

  // Ensure Rust wasm32 target is installed
  try {
    execCommand('rustup target add wasm32-unknown-unknown', { cwd: contractPath });
  } catch (err) {
    core.warning(`rustup target add warning: ${err.message}`);
  }

  // Check for cargo-near first (preferred)
  const hasCargoNear = commandExists('cargo-near');

  if (hasCargoNear) {
    core.info('Using cargo-near for build…');
    execCommand('cargo near build', { cwd: contractPath });
  } else {
    core.info('Using cargo build --target wasm32-unknown-unknown…');
    execCommand(
      'cargo build --target wasm32-unknown-unknown --release',
      { cwd: contractPath }
    );
  }

  // Find the built wasm
  const wasmFiles = findWasmFiles(contractPath);
  if (wasmFiles.length === 0) {
    throw new Error('Rust build succeeded but no .wasm file found.');
  }

  // Prefer release build
  const releaseWasm = wasmFiles.find((f) => f.includes('release'));
  return releaseWasm || wasmFiles[0];
}

async function buildAssemblyScriptContract(contractPath) {
  core.info('Detected AssemblyScript/JS contract — building with npm…');

  // Install dependencies
  execCommand('npm install', { cwd: contractPath });

  // Try common build scripts
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(contractPath, 'package.json'), 'utf8')
  );
  const scripts = packageJson.scripts || {};

  if (scripts.build) {
    execCommand('npm run build', { cwd: contractPath });
  } else if (scripts['build:contract']) {
    execCommand('npm run build:contract', { cwd: contractPath });
  } else {
    // Try npx asc directly
    const assemblyDir = path.join(contractPath, 'assembly', 'index.ts');
    if (fs.existsSync(assemblyDir)) {
      execCommand(
        `npx asc assembly/index.ts --target release --outFile build/contract.wasm`,
        { cwd: contractPath }
      );
    } else {
      throw new Error('No build script found and cannot determine AssemblyScript entry point.');
    }
  }

  const wasmFiles = findWasmFiles(contractPath);
  if (wasmFiles.length === 0) {
    throw new Error('AssemblyScript build succeeded but no .wasm file found.');
  }
  return wasmFiles[0];
}

function findWasmFiles(dir) {
  const results = [];
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.wasm')) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Step 4: Run smoke tests
// ---------------------------------------------------------------------------

async function runSmokeTests(accountId, testScriptPath, runTests) {
  core.startGroup('Step 4 — Smoke tests');

  if (!runTests) {
    core.info('Test execution disabled — skipping.');
    core.endGroup();
    return { ran: false, skipped: true, passed: null };
  }

  const absTestScript = path.resolve(testScriptPath);

  if (!fs.existsSync(absTestScript)) {
    core.warning(`Test script not found: ${absTestScript} — skipping tests.`);
    core.endGroup();
    return { ran: false, skipped: true, passed: null, reason: 'test script not found' };
  }

  core.info(`Running smoke tests: ${absTestScript}`);

  // Install test dependencies if there's a package.json in the test dir
  const testDir = path.dirname(absTestScript);
  const testPackageJson = path.join(testDir, 'package.json');
  if (fs.existsSync(testPackageJson)) {
    core.info('Installing test dependencies…');
    execCommand('npm install', { cwd: testDir });
  }

  const testResult = spawnSync(
    'node',
    [absTestScript],
    {
      env: {
        ...process.env,
        NEAR_ACCOUNT_ID: accountId,
        NEAR_ENV: 'testnet',
        NEAR_NETWORK_ID: 'testnet',
        NEAR_NODE_URL: 'https://rpc.testnet.near.org',
      },
      timeout: 120000,
      encoding: 'utf8',
    }
  );

  const stdout = testResult.stdout || '';
  const stderr = testResult.stderr || '';

  if (stdout) core.info(`Test stdout:\n${stdout}`);
  if (stderr) core.info(`Test stderr:\n${stderr}`);

  const passed = testResult.status === 0;

  if (passed) {
    core.info('✅ Smoke tests passed.');
  } else {
    core.error(`❌ Smoke tests failed (exit code ${testResult.status}).`);
  }

  core.endGroup();
  return {
    ran: true,
    skipped: false,
    passed,
    exitCode: testResult.status,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Step 5: Report results
// ---------------------------------------------------------------------------

async function reportResults(accountId, deployInfo, fundingInfo, testInfo) {
  core.startGroup('Step 5 — Results report');

  const lines = [
    '═══════════════════════════════════════════════',
    '  NEAR Testnet Deploy — Pipeline Summary',
    '═══════════════════════════════════════════════',
    `  Account  : ${accountId}`,
    `  Network  : testnet`,
    `  WASM     : ${deployInfo.wasmSize ? (deployInfo.wasmSize / 1024).toFixed(2) + ' KB' : 'N/A'}`,
    `  Tx Hash  : ${deployInfo.txHash || 'N/A'}`,
    `  Code Hash: ${deployInfo.codeHash || 'N/A'}`,
    '',
    '  Funding',
    `    Enabled  : ${fundingInfo.skipped ? 'no (sufficient balance)' : fundingInfo.funded ? 'yes' : 'attempted (failed)'}`,
    fundingInfo.balanceAfter
      ? `    Balance  : ${formatNear(BigInt(fundingInfo.balanceAfter))} NEAR`
      : '',
    '',
    '  Tests',
    `    Run      : ${testInfo.ran ? 'yes' : 'no'}`,
    testInfo.ran ? `    Result   : ${testInfo.passed ? '✅ PASSED' : '❌ FAILED'}` : '',
    '═══════════════════════════════════════════════',
  ].filter((l) => l !== undefined);

  for (const line of lines) {
    core.info(line);
  }

  // Set Action outputs
  core.setOutput('account_id', accountId);
  core.setOutput('contract_code_hash', deployInfo.codeHash || '');
  core.setOutput('deploy_tx_hash', deployInfo.txHash || '');
  core.setOutput('tests_passed', testInfo.ran ? String(testInfo.passed) : 'skipped');

  // Generate a GitHub Step Summary if GITHUB_STEP_SUMMARY is set
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const summary = [
      '## 🚀 NEAR Testnet Deploy Results',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **Account** | \`${accountId}\` |`,
      `| **Network** | testnet |`,
      `| **WASM Size** | ${deployInfo.wasmSize ? (deployInfo.wasmSize / 1024).toFixed(2) + ' KB' : 'N/A'} |`,
      `| **Deploy Tx** | \`${deployInfo.txHash || 'N/A'}\` |`,
      `| **Code Hash** | \`${deployInfo.codeHash || 'N/A'}\` |`,
      `| **Tests** | ${testInfo.ran ? (testInfo.passed ? '✅ Passed' : '❌ Failed') : '⏭️ Skipped'} |`,
    ].join('\n');

    fs.appendFileSync(summaryFile, summary + '\n');
    core.info('Step summary written.');
  }

  core.endGroup();
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatNear(yocto) {
  const near = Number(yocto) / 1e24;
  return near.toFixed(4);
}

function execCommand(cmd, options = {}) {
  core.info(`$ ${cmd}`);
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      ...options,
    });
    return {