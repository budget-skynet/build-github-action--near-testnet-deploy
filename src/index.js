async function jsonPost(url, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
    },
  }, body);
  try {
    return { status: res.status, data: JSON.parse(res.body) };
  } catch {
    return { status: res.status, data: res.body };
  }
}

async function jsonGet(url) {
  const res = await request(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  try {
    return { status: res.status, data: JSON.parse(res.body) };
  } catch {
    return { status: res.status, data: res.body };
  }
}

// ---------------------------------------------------------------------------
// NEAR RPC helper
// ---------------------------------------------------------------------------
const RPC_URL = 'https://rpc.testnet.near.org';

async function nearRpcCall(method, params) {
  const payload = { jsonrpc: '2.0', id: 'near-testnet-deploy', method, params };
  const res = await jsonPost(RPC_URL, payload);
  if (res.status !== 200) {
    throw new Error(`RPC HTTP error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  if (res.data.error) {
    throw new Error(`RPC error: ${JSON.stringify(res.data.error)}`);
  }
  return res.data.result;
}

async function queryAccount(accountId) {
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return result;
  } catch (err) {
    if (err.message.includes('does not exist') || err.message.includes('UNKNOWN_ACCOUNT')) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// near-cli wrapper – used for deploy and call operations
// ---------------------------------------------------------------------------
function findNearCli() {
  // Prefer locally installed near-cli or near-cli-rs
  const candidates = ['near', 'npx near'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch { /* continue */ }
  }
  return null;
}

function installNearCli() {
  core.info('Installing near-cli globally …');
  execSync('npm install -g near-cli@3', { stdio: 'inherit' });
}

function exec(cmd, opts = {}) {
  core.debug(`$ ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd || process.cwd(),
  });
  if (result.error) throw result.error;
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}):\n${stderr || stdout}`);
  }
  return stdout;
}

// ---------------------------------------------------------------------------
// Credential file helper (near-cli uses ~/.near-credentials)
// ---------------------------------------------------------------------------
function writeCredentials(accountId, privateKey) {
  // near-cli expects ed25519 keys stored as JSON
  // private key format: "ed25519:<base58>"
  const network = 'testnet';
  const credDir = path.join(os.homedir(), '.near-credentials', network);
  fs.mkdirSync(credDir, { recursive: true });
  const credFile = path.join(credDir, `${accountId}.json`);

  // Normalise private key – accept with or without "ed25519:" prefix
  let privateKeyNorm = privateKey;
  if (!privateKeyNorm.startsWith('ed25519:') && !privateKeyNorm.startsWith('secp256k1:')) {
    privateKeyNorm = `ed25519:${privateKeyNorm}`;
  }

  // Derive public key using near-cli's key derivation (or just store what we have)
  // near-cli will derive publicKey from private key at runtime; we can store a placeholder
  // but it must be present in the JSON. We'll let near-cli recalculate it by omitting
  // publicKey and instead use the implicit format near-cli-rs expects.
  // For near-cli v3 the format is:
  //   { "account_id": "…", "public_key": "ed25519:…", "private_key": "ed25519:…" }
  // We derive the public key using the tweetnacl library if available, otherwise we
  // store a stub and rely on near-cli re-importing.
  let publicKey = '';
  try {
    // Try to use the built-in crypto to derive the key via near-seed-phrase if available
    const nacl = require('tweetnacl'); // may not be installed
    const bs58 = require('bs58');
    const rawPriv = bs58.decode(privateKeyNorm.replace(/^ed25519:/, ''));
    const pair = nacl.sign.keyPair.fromSecretKey(rawPriv.slice(0, 32));
    publicKey = `ed25519:${bs58.encode(pair.publicKey)}`;
  } catch {
    // tweetnacl / bs58 not available – near-cli v3 can infer publicKey from private key
    // so we write an empty string; near-cli will fix it on first use
    publicKey = '';
  }

  const cred = {
    account_id: accountId,
    public_key: publicKey || undefined,
    private_key: privateKeyNorm,
  };
  // Remove undefined keys
  Object.keys(cred).forEach(k => cred[k] === undefined && delete cred[k]);
  fs.writeFileSync(credFile, JSON.stringify(cred, null, 2));
  core.info(`Credentials written to ${credFile}`);
  return credFile;
}

// ---------------------------------------------------------------------------
// STEP 1 — Resolve / auto-create testnet account
// ---------------------------------------------------------------------------
async function stepResolveAccount(accountId, privateKey) {
  core.startGroup('Step 1 — Resolve testnet account');
  core.info(`Checking account: ${accountId}`);

  const accountInfo = await queryAccount(accountId);

  if (accountInfo) {
    core.info(`Account exists. Balance: ${accountInfo.amount} yoctoNEAR`);
    core.endGroup();
    return { existed: true, accountInfo };
  }

  core.info(`Account ${accountId} does not exist — attempting implicit account creation via faucet …`);

  // NEAR testnet allows implicit accounts (64-char hex) to be created by sending tokens.
  // For named accounts (*.testnet) we rely on the testnet helper to create them.
  const helperUrl = `https://helper.testnet.near.org/account`;
  // The testnet helper creates accounts. We need the public key.
  // Extract public key from private key via near-cli key import
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-'));
  const keyFile = path.join(tmpDir, 'key.json');

  // Write private key to temp file for near-cli
  fs.writeFileSync(keyFile, JSON.stringify({
    account_id: accountId,
    private_key: privateKey.startsWith('ed25519:') ? privateKey : `ed25519:${privateKey}`,
  }));

  // Try the testnet helper create-account endpoint
  const helperPayload = {
    newAccountId: accountId,
    newAccountPublicKey: privateKey,
  };

  try {
    const helperRes = await jsonPost(helperUrl, helperPayload);
    if (helperRes.status === 200 || helperRes.status === 201) {
      core.info(`Account ${accountId} created via testnet helper.`);
    } else {
      core.warning(`Testnet helper returned ${helperRes.status}: ${JSON.stringify(helperRes.data)}`);
      core.warning('Proceeding — account may already exist or will be funded by faucet.');
    }
  } catch (err) {
    core.warning(`Testnet helper request failed: ${err.message}`);
    core.warning('Proceeding to faucet funding step.');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  core.endGroup();
  return { existed: false, accountInfo: null };
}

// ---------------------------------------------------------------------------
// STEP 2 — Request faucet funding
// ---------------------------------------------------------------------------
async function stepFaucetFunding(accountId, requestAmount) {
  core.startGroup('Step 2 — Request faucet funding');
  core.info(`Requesting ${requestAmount} NEAR from testnet faucet for ${accountId} …`);

  // Primary faucet: nearprotocol/near-contract-helper testnet helper
  const primaryUrl = `https://helper.testnet.near.org/account/${accountId}/fund`;
  // Secondary faucet endpoint (public)
  const secondaryUrl = 'https://testnet.near.org/near-faucet';

  let funded = false;

  // Attempt 1 — testnet helper fund endpoint
  try {
    const res = await request(primaryUrl, { method: 'POST', headers: {} });
    if (res.status === 200 || res.status === 201 || res.status === 204) {
      core.info('Faucet funding request succeeded (primary endpoint).');
      funded = true;
    } else {
      core.warning(`Primary faucet returned HTTP ${res.status}: ${res.body.substring(0, 200)}`);
    }
  } catch (err) {
    core.warning(`Primary faucet request error: ${err.message}`);
  }

  // Attempt 2 — near-api-js compatible helper
  if (!funded) {
    try {
      const res2 = await jsonPost(
        `https://helper.testnet.near.org/account`,
        { newAccountId: accountId, newAccountPublicKey: '' },
      );
      if (res2.status < 300) {
        core.info('Faucet funding request succeeded (helper fallback).');
        funded = true;
      } else {
        core.warning(`Fallback faucet returned HTTP ${res2.status}`);
      }
    } catch (err2) {
      core.warning(`Fallback faucet error: ${err2.message}`);
    }
  }

  if (!funded) {
    core.warning(
      'Automated faucet funding could not be confirmed. ' +
      'If the account already has funds this is not an error. Continuing …',
    );
  }

  // Wait a few seconds for the funding transaction to be indexed
  core.info('Waiting 5 s for faucet tx to finalize …');
  await new Promise(r => setTimeout(r, 5000));

  // Re-check balance
  let balance = 'unknown';
  try {
    const info = await queryAccount(accountId);
    if (info) {
      balance = `${BigInt(info.amount) / BigInt('1000000000000000000000000')} NEAR`;
      core.info(`Account balance after faucet: ${balance}`);
    } else {
      core.warning('Account still not visible on-chain. Faucet may be slow — continuing.');
    }
  } catch (err) {
    core.warning(`Balance check failed: ${err.message}`);
  }

  core.endGroup();
  return { funded, balance };
}

// ---------------------------------------------------------------------------
// STEP 3 — Build & deploy the contract
// ---------------------------------------------------------------------------
async function stepDeploy(contractPath, accountId, nearCli) {
  core.startGroup('Step 3 — Build & Deploy contract');

  let wasmFile = contractPath;

  // Resolve absolute path
  const absPath = path.resolve(contractPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`contract_path does not exist: ${absPath}`);
  }

  const stat = fs.statSync(absPath);

  if (stat.isDirectory()) {
    core.info(`contract_path is a directory. Looking for build artefacts …`);

    // Try to find existing .wasm in expected output dirs
    const searchDirs = [
      path.join(absPath, 'res'),
      path.join(absPath, 'out'),
      path.join(absPath, 'target', 'wasm32-unknown-unknown', 'release'),
      path.join(absPath, 'target', 'near'),
      absPath,
    ];

    let found = null;
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.wasm'));
      if (files.length > 0) {
        found = path.join(dir, files[0]);
        core.info(`Found pre-built WASM: ${found}`);
        break;
      }
    }

    if (!found) {
      // Try to build
      core.info('No pre-built WASM found. Attempting to build …');

      // Check for Cargo.toml → Rust contract
      if (fs.existsSync(path.join(absPath, 'Cargo.toml'))) {
        core.info('Detected Rust contract. Running cargo build …');
        try {
          // Ensure wasm32 target is available
          exec('rustup target add wasm32-unknown-unknown');
          exec(
            'cargo build --target wasm32-unknown-unknown --release',
            { cwd: absPath },
          );
          // Find built WASM
          const releaseDir = path.join(absPath, 'target', 'wasm32-unknown-unknown', 'release');
          const wasms = fs.readdirSync(releaseDir).filter(f => f.endsWith('.wasm'));
          if (wasms.length === 0) throw new Error('cargo build succeeded but no .wasm found.');
          found = path.join(releaseDir, wasms[0]);
          core.info(`Built WASM: ${found}`);
        } catch (err) {
          throw new Error(`Rust build failed: ${err.message}`);
        }
      }
      // Check for package.json → AssemblyScript / JS contract
      else if (fs.existsSync(path.join(absPath, 'package.json'))) {
        core.info('Detected JS/AS contract. Running npm build …');
        exec('npm install', { cwd: absPath });
        try {
          exec('npm run build', { cwd: absPath });
        } catch {
          exec('npm run compile', { cwd: absPath });
        }
        // Search again
        for (const dir of searchDirs) {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.wasm'));
          if (files.length > 0) { found = path.join(dir, files[0]); break; }
        }
        if (!found) throw new Error('JS/AS build succeeded but no .wasm file found.');
      } else {
        throw new Error(
          `Cannot determine how to build contract in ${absPath}. ` +
          'Provide a pre-built .wasm file or a Rust/AssemblyScript project directory.',
        );
      }
    }

    wasmFile = found;
  } else {
    // It's a file — must be .wasm
    if (!absPath.endsWith('.wasm')) {
      throw new Error(`contract_path must be a .wasm file or a project directory. Got: ${absPath}`);
    }
    wasmFile = absPath;
  }

  core.info(`Deploying ${wasmFile} to ${accountId} …`);

  // Deploy using near-cli
  const deployCmd =
    `${nearCli} deploy ` +
    `--accountId ${accountId} ` +
    `--wasmFile ${wasmFile} ` +
    `--networkId testnet ` +
    `--nodeUrl ${RPC_URL}`;

  let deployOutput;
  try {
    deployOutput = exec(deployCmd, {
      env: { NEAR_ENV: 'testnet' },
    });
    core.info('Deploy output:\n' + deployOutput);
  } catch (err) {
    throw new Error(`Contract deployment failed: ${err.message}`);
  }

  // Extract transaction hash from output if present
  const txHashMatch = deployOutput.match(/Transaction\s+ID[:\s]+([A-Za-z0-9]+)/i)
    || deployOutput.match(/hash[:\s]+([A-Za-z0-9]{43,44})/i);
  const txHash = txHashMatch ? txHashMatch[1] : 'unknown';

  core.info(`Deploy transaction hash: ${txHash}`);
  core.setOutput('deploy_tx_hash', txHash);

  core.endGroup();
  return { wasmFile, txHash };
}

// ---------------------------------------------------------------------------
// STEP 4 — Basic smoke tests
// ---------------------------------------------------------------------------
async function stepSmokeTests(accountId, testScriptPath, nearCli) {
  core.startGroup('Step 4 — Smoke tests');

  const results = [];

  // ------------------------------------------------------------------
  // Built-in smoke test: verify the contract is deployed by querying
  // the account's code_hash via RPC
  // ------------------------------------------------------------------
  core.info('Smoke test 1: verify contract code is deployed on-chain …');
  let codeHashOk = false;
  try {
    const info = await queryAccount(accountId);
    if (!info) throw new Error('Account not found');
    const codeHash = info.code_hash;
    if (!codeHash || codeHash === '11111111111111111111111111111111') {
      throw new Error(`code_hash is empty/default — contract may not have been deployed. Got: ${codeHash}`);
    }
    core.info(`✅ Contract deployed. code_hash = ${codeHash}`);
    results.push({ name: 'contract-deployed', passed: true, detail: codeHash });
    codeHashOk = true;
  } catch (err) {
    core.error(`❌ Contract deployment check failed: ${err.message}`);
    results.push({ name: 'contract-deployed', passed: false, detail: err.message });
  }

  // ------------------------------------------------------------------
  // Built-in smoke test: call view method `version` (if it exists)
  // Many NEAR contracts expose this. We swallow errors gracefully.
  // ------------------------------------------------------------------
  core.info('Smoke test 2: attempt view call to `version` method …');
  try {
    const viewCmd =
      `${nearCli} view ${accountId} version '{}' ` +
      `--networkId testnet --nodeUrl ${RPC_URL}`;
    const out = exec(viewCmd, { env: { NEAR_ENV: 'testnet' } });
    core.info(`version() returned: ${out}`);
    results.push({ name: 'view-version', passed: true, detail: out });
  } catch (err) {
    // Not a failure — many contracts don't have `version`
    core.info(`view version(): not available or errored (non-fatal): ${err.message.split('\n')[0]}`);
    results.push({ name: 'view-version', passed: null, detail: 'method not found (skipped)' });
  }

  // ------------------------------------------------------------------
  // User-supplied test script
  // ------------------------------------------------------------------
  if (testScriptPath && testScriptPath.trim() !== '') {
    core.info(`Smoke test 3: running user-supplied test script: ${testScriptPath} …`);
    const absScript = path.resolve(testScriptPath.trim());

    // Could be a shell command OR a file path
    const isFile = fs.existsSync(absScript);

    try {
      let scriptOutput;
      if (isFile) {
        const ext = path.extname(absScript);
        if (ext === '.js' || ext === '.mjs') {
          scriptOutput = exec(`node ${absScript}`, {
            env: {
              NEAR_ENV: 'testnet',
              NEAR_ACCOUNT_ID: accountId,
              RPC_URL,
            },
          });
        } else if (ext === '.sh') {
          exec(`chmod +x ${absScript}`);
          scriptOutput = exec(absScript, {
            env: {
              NEAR_ENV: 'testnet',
              NEAR_ACCOUNT_ID: accountId,
              RPC_URL,
            },
          });
        } else {
          scriptOutput = exec(absScript, {
            env: { NEAR_ENV: 'testnet', NEAR_ACCOUNT_ID: accountId, RPC_URL },
          });
        }
      } else {
        // Treat as a shell command string
        scriptOutput = exec(testScriptPath.trim(), {
          env: { NEAR_ENV: 'testnet', NEAR_ACCOUNT_ID: accountId, RPC_URL },
        });
      }
      core.info(`Test script output:\n${scriptOutput}`);
      results.push({ name: 'user-test-script', passed: true, detail: scriptOutput.substring(0, 500) });
    } catch (err) {
      core.error(`❌ User test script failed: ${err.message}`);
      results.push({ name: 'user-test-script', passed: false, detail: err.message });
    }
  }

  core.endGroup();
  return results;
}

// ---------------------------------------------------------------------------
// STEP 5 — Report results
// ---------------------------------------------------------------------------