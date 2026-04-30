async function nearRpc(rpcUrl, method, params) {
  const payload = {
    jsonrpc: '2.0',
    id: 'near-deploy-action',
    method,
    params,
  };
  const result = await httpRequest(
    rpcUrl,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    payload
  );
  if (result.error) {
    throw new Error(`NEAR RPC error (${method}): ${JSON.stringify(result.error)}`);
  }
  return result.result;
}

// ---------------------------------------------------------------------------
// Check whether a NEAR account exists
// ---------------------------------------------------------------------------
async function accountExists(rpcUrl, accountId) {
  try {
    await nearRpc(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return true;
  } catch (err) {
    // "does not exist" surfaces as an RPC error
    if (
      err.message.includes('does not exist') ||
      err.message.includes('Unknown account')
    ) {
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write NEAR credentials file so near-cli picks them up
// ---------------------------------------------------------------------------
function writeCredentials(accountId, privateKey, publicKey) {
  const credDir = path.join(os.homedir(), '.near-credentials', 'testnet');
  fs.mkdirSync(credDir, { recursive: true });

  const credFile = path.join(credDir, `${accountId}.json`);
  const cred = {
    account_id: accountId,
    public_key: publicKey,
    private_key: privateKey,
  };
  fs.writeFileSync(credFile, JSON.stringify(cred, null, 2), { mode: 0o600 });
  core.info(`Credentials written to ${credFile}`);
}

// ---------------------------------------------------------------------------
// Derive public key from private key using near-cli
// ---------------------------------------------------------------------------
function derivePublicKey(privateKey) {
  // near-cli stores the keypair; we can use it to echo the public key.
  // Alternatively we shell out to node with tweetnacl if available.
  // Strategy: write a tiny throwaway script.
  const script = `
    const { KeyPair } = require('near-api-js');
    try {
      const kp = KeyPair.fromString(${JSON.stringify(privateKey)});
      process.stdout.write(kp.getPublicKey().toString());
    } catch (e) {
      process.stderr.write(e.message);
      process.exit(1);
    }
  `;
  const tmpScript = path.join(os.tmpdir(), 'derive_pubkey.js');
  fs.writeFileSync(tmpScript, script);

  // Try with near-api-js if installed in the action's own node_modules
  const actionNodeModules = path.join(__dirname, '..', 'node_modules');
  const result = spawnSync(
    process.execPath,
    ['-e', script],
    {
      env: {
        ...process.env,
        NODE_PATH: actionNodeModules,
      },
      encoding: 'utf8',
      timeout: 10000,
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to derive public key: ${result.stderr || result.error}`
    );
  }
  fs.unlinkSync(tmpScript);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// STEP 1 – Auto-create testnet account if it doesn't exist
// ---------------------------------------------------------------------------
async function stepEnsureAccount(rpcUrl, accountId, privateKey) {
  core.startGroup('Step 1 – Ensure testnet account exists');

  const exists = await accountExists(rpcUrl, accountId);
  if (exists) {
    core.info(`Account ${accountId} already exists – skipping creation`);
    core.endGroup();
    return { accountCreated: false };
  }

  core.info(`Account ${accountId} not found – attempting to create via faucet helper`);

  // The NEAR testnet helper can create accounts
  const helperUrl = 'https://helper.testnet.near.org';
  let publicKey;
  try {
    publicKey = derivePublicKey(privateKey);
    core.info(`Derived public key: ${publicKey}`);
  } catch (err) {
    core.warning(
      `Could not derive public key automatically: ${err.message}. ` +
        `Will attempt account creation without explicit key — ` +
        `account must be created manually if this fails.`
    );
    publicKey = null;
  }

  if (publicKey) {
    try {
      await httpRequest(
        `${helperUrl}/account`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        { newAccountId: accountId, newAccountPublicKey: publicKey }
      );
      core.info(`Account ${accountId} created via NEAR helper`);
    } catch (err) {
      core.warning(
        `NEAR helper account creation failed (${err.message}). ` +
          `Proceeding – faucet funding step may create the account.`
      );
    }
  }

  // Verify
  const nowExists = await accountExists(rpcUrl, accountId);
  if (!nowExists) {
    core.warning(
      `Account ${accountId} still does not appear in state. ` +
        `Continuing – it may appear after faucet funding.`
    );
  }

  core.endGroup();
  return { accountCreated: !exists, publicKey };
}

// ---------------------------------------------------------------------------
// STEP 2 – Request faucet funding
// ---------------------------------------------------------------------------
async function stepFaucetFunding(accountId, fundingAmount) {
  core.startGroup('Step 2 – Request faucet funding');

  const amountNear = parseFloat(fundingAmount) || 10;
  core.info(`Requesting ${amountNear} NEAR for account ${accountId}`);

  // Primary: near-faucet.io
  const faucetEndpoints = [
    {
      url: 'https://near-faucet.io/api/faucet/tokens',
      body: { account_id: accountId, amount: String(amountNear) },
      label: 'near-faucet.io',
    },
    {
      url: 'https://helper.testnet.near.org/account/fund',
      body: { account_id: accountId },
      label: 'NEAR helper fund',
    },
  ];

  let funded = false;
  for (const endpoint of faucetEndpoints) {
    try {
      core.info(`Trying faucet: ${endpoint.label} (${endpoint.url})`);
      const resp = await httpRequest(
        endpoint.url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'near-testnet-deploy-action/1.0',
          },
          timeout: 60000,
        },
        endpoint.body
      );
      core.info(`Faucet response from ${endpoint.label}: ${JSON.stringify(resp)}`);
      funded = true;
      break;
    } catch (err) {
      core.warning(`Faucet ${endpoint.label} failed: ${err.message}`);
    }
  }

  if (!funded) {
    core.warning(
      'All faucet endpoints failed. ' +
        'The account may already be funded, or you may need to fund it manually.'
    );
  }

  // Give the network a moment to process
  core.info('Waiting 5 s for faucet transaction to settle…');
  await new Promise((r) => setTimeout(r, 5000));

  core.endGroup();
  return { funded };
}

// ---------------------------------------------------------------------------
// STEP 3 – Build & Deploy contract
// ---------------------------------------------------------------------------
async function stepDeploy(contractPath, accountId) {
  core.startGroup('Step 3 – Build & Deploy contract');

  const absContractPath = path.resolve(contractPath);
  if (!fs.existsSync(absContractPath)) {
    throw new Error(`contract_path does not exist: ${absContractPath}`);
  }

  let wasmFile = null;

  // If the path itself is a .wasm file, use it directly
  if (absContractPath.endsWith('.wasm')) {
    wasmFile = absContractPath;
    core.info(`Using pre-built WASM: ${wasmFile}`);
  } else {
    // Attempt to build
    core.info(`Building contract in ${absContractPath}…`);

    const isRust =
      fs.existsSync(path.join(absContractPath, 'Cargo.toml'));
    const isAssemblyScript =
      fs.existsSync(path.join(absContractPath, 'asconfig.json')) ||
      fs.existsSync(path.join(absContractPath, 'assembly'));
    const isJs =
      fs.existsSync(path.join(absContractPath, 'package.json'));

    if (isRust) {
      core.info('Detected Rust contract – building with cargo');
      execSync(
        'cargo build --target wasm32-unknown-unknown --release',
        { cwd: absContractPath, stdio: 'inherit' }
      );
      // Find the wasm output
      const targetDir = path.join(absContractPath, 'target', 'wasm32-unknown-unknown', 'release');
      const wasmFiles = fs
        .readdirSync(targetDir)
        .filter((f) => f.endsWith('.wasm'));
      if (wasmFiles.length === 0) {
        throw new Error('Rust build produced no .wasm files');
      }
      wasmFile = path.join(targetDir, wasmFiles[0]);
    } else if (isAssemblyScript) {
      core.info('Detected AssemblyScript contract – building with npm run build');
      execSync('npm install', { cwd: absContractPath, stdio: 'inherit' });
      execSync('npm run build', { cwd: absContractPath, stdio: 'inherit' });
      // Find wasm in build/ or out/
      for (const outDir of ['build', 'out']) {
        const candidate = path.join(absContractPath, outDir);
        if (fs.existsSync(candidate)) {
          const found = fs
            .readdirSync(candidate)
            .filter((f) => f.endsWith('.wasm'));
          if (found.length > 0) {
            wasmFile = path.join(candidate, found[0]);
            break;
          }
        }
      }
      if (!wasmFile) throw new Error('AssemblyScript build produced no .wasm files');
    } else if (isJs) {
      core.info('Detected JS/TS contract – running npm run build');
      execSync('npm install', { cwd: absContractPath, stdio: 'inherit' });
      execSync('npm run build', { cwd: absContractPath, stdio: 'inherit' });
      // Look for wasm in common output directories
      for (const outDir of ['build', 'out', 'dist', '.']) {
        const candidate = path.join(absContractPath, outDir);
        if (fs.existsSync(candidate)) {
          const found = fs
            .readdirSync(candidate)
            .filter((f) => f.endsWith('.wasm'));
          if (found.length > 0) {
            wasmFile = path.join(candidate, found[0]);
            break;
          }
        }
      }
      if (!wasmFile) throw new Error('JS build produced no .wasm files');
    } else {
      throw new Error(
        `Cannot determine contract type in ${absContractPath}. ` +
          'Expected Cargo.toml, asconfig.json, or package.json.'
      );
    }
  }

  core.info(`WASM file: ${wasmFile} (${fs.statSync(wasmFile).size} bytes)`);

  // Deploy via near-cli
  core.info(`Deploying to account ${accountId}…`);
  const deployCmd = `near deploy --accountId ${accountId} --wasmFile ${wasmFile} --networkId testnet`;
  execSync(deployCmd, {
    stdio: 'inherit',
    env: { ...process.env, NEAR_ENV: 'testnet' },
  });

  core.info('Contract deployed successfully');
  core.endGroup();
  return { wasmFile };
}

// ---------------------------------------------------------------------------
// STEP 4 – Verify deployment via RPC
// ---------------------------------------------------------------------------
async function stepVerifyDeployment(rpcUrl, accountId, wasmFile) {
  core.startGroup('Step 4 – Verify deployment');

  core.info('Querying account state to confirm contract is deployed…');
  const accountState = await nearRpc(rpcUrl, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });

  core.info(`Account state: ${JSON.stringify(accountState, null, 2)}`);

  const codeHash = accountState.code_hash;
  if (!codeHash || codeHash === '11111111111111111111111111111111') {
    throw new Error(
      `Deployment verification failed: code_hash is still empty (${codeHash}). ` +
        'The contract may not have been deployed.'
    );
  }
  core.info(`Contract code hash on-chain: ${codeHash}`);

  // Also fetch the deployed code size from RPC
  try {
    const viewCode = await nearRpc(rpcUrl, 'query', {
      request_type: 'view_code',
      finality: 'final',
      account_id: accountId,
    });
    core.info(`On-chain code size: ${viewCode.code_base64?.length ?? 'unknown'} base64 chars`);
  } catch (err) {
    core.warning(`Could not fetch view_code: ${err.message}`);
  }

  core.setOutput('code_hash', codeHash);
  core.endGroup();
  return { codeHash };
}

// ---------------------------------------------------------------------------
// STEP 5 – Run smoke tests
// ---------------------------------------------------------------------------
async function stepSmokeTests(
  smokeTestsEnabled,
  testScriptPath,
  accountId,
  rpcUrl
) {
  core.startGroup('Step 5 – Smoke tests');

  if (smokeTestsEnabled !== 'true') {
    core.info('Smoke tests disabled (smoke_tests_enabled != true) – skipping');
    core.endGroup();
    return { skipped: true, passed: null };
  }

  let passed = true;
  const results = [];

  // ------------------------------------------------------------------
  // 5a. Basic RPC smoke test – view_account should return healthy state
  // ------------------------------------------------------------------
  core.info('Smoke test 1: view_account RPC check');
  try {
    const state = await nearRpc(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    const balance = BigInt(state.amount || '0');
    const hasBalance = balance > 0n;
    const hasCode =
      state.code_hash && state.code_hash !== '11111111111111111111111111111111';

    if (!hasBalance) {
      core.warning('Account balance is 0 – faucet may not have completed yet');
    }
    if (!hasCode) {
      passed = false;
      results.push({ test: 'view_account', status: 'FAIL', reason: 'code_hash is empty' });
    } else {
      results.push({ test: 'view_account', status: 'PASS', code_hash: state.code_hash });
    }
  } catch (err) {
    passed = false;
    results.push({ test: 'view_account', status: 'FAIL', reason: err.message });
  }

  // ------------------------------------------------------------------
  // 5b. User-supplied test script
  // ------------------------------------------------------------------
  if (testScriptPath && testScriptPath.trim() !== '') {
    const absTestPath = path.resolve(testScriptPath.trim());
    core.info(`Smoke test 2: running user test script: ${absTestPath}`);

    if (!fs.existsSync(absTestPath)) {
      core.warning(`test_script_path does not exist: ${absTestPath} – skipping`);
      results.push({
        test: 'user_script',
        status: 'SKIP',
        reason: 'file not found',
      });
    } else {
      const ext = path.extname(absTestPath).toLowerCase();
      let cmd;
      if (ext === '.js' || ext === '.mjs' || ext === '.ts') {
        cmd = ext === '.ts' ? `npx ts-node ${absTestPath}` : `node ${absTestPath}`;
      } else if (ext === '.sh') {
        cmd = `bash ${absTestPath}`;
      } else {
        // Assume it's an npm/yarn script name or arbitrary command
        cmd = testScriptPath.trim();
      }

      const result = spawnSync(cmd, [], {
        shell: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          NEAR_CONTRACT_ID: accountId,
          NEAR_RPC_URL: rpcUrl,
          NEAR_ENV: 'testnet',
        },
        timeout: 120000,
      });

      if (result.status === 0) {
        results.push({ test: 'user_script', status: 'PASS' });
      } else {
        passed = false;
        results.push({
          test: 'user_script',
          status: 'FAIL',
          exit_code: result.status,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 5c. Summary
  // ------------------------------------------------------------------
  core.info('\n=== Smoke Test Results ===');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭️' : '❌';
    core.info(`${icon} [${r.status}] ${r.test}${r.reason ? ': ' + r.reason : ''}`);
  }

  core.endGroup();
  return { skipped: false, passed, results };
}

// ---------------------------------------------------------------------------
// STEP 6 – Report results
// ---------------------------------------------------------------------------
function stepReport(context) {
  core.startGroup('Step 6 – Final report');

  const {
    accountId,
    accountCreated,
    funded,
    wasmFile,
    codeHash,
    smokeResults,
  } = context;

  const lines = [
    '## NEAR Testnet Deploy Report',
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| **Account** | \`${accountId}\` |`,
    `| **Network** | testnet |`,
    `| **Account Created** | ${accountCreated ? '✅ Yes' : '⬜ Pre-existing'} |`,
    `| **Faucet Funded** | ${funded ? '✅ Yes' : '⚠️ Skipped/Failed'} |`,
    `| **WASM File** | \`${path.basename(wasmFile)}\` |`,
    `| **Code Hash** | \`${codeHash}\` |`,
  ];

  if (smokeResults.skipped) {
    lines.push(`| **Smoke Tests** | ⏭️ Skipped |`);
  } else if (smokeResults.passed) {
    lines.push(`| **Smoke Tests** | ✅ All passed |`);
  } else {
    lines.push(`| **Smoke Tests** | ❌ One or more failed |`);
  }

  lines.push('');
  lines.push(
    `> Contract deployed at \`${accountId}\` on NEAR testnet. ` +
      `Explorer: https://testnet.nearblocks.io/address/${accountId}`
  );

  const report = lines.join('\n');
  core.info(report);

  // Set action outputs
  core.setOutput('account_id', accountId);
  core.setOutput('code_hash', codeHash);
  core.setOutput('smoke_tests_passed', String(smokeResults.passed ?? false));
  core.setOutput('deploy_success', 'true');

  // Write to GitHub step summary if available
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, report + '\n');
    } catch {
      // Non-fatal
    }
  }

  core.endGroup();