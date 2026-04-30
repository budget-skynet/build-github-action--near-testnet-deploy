async function runCommand(cmd, args = [], opts = {}) {
  let stdout = '';
  let stderr = '';
  const options = {
    listeners: {
      stdout: (data) => { stdout += data.toString(); },
      stderr: (data) => { stderr += data.toString(); },
    },
    ignoreReturnCode: opts.ignoreReturnCode || false,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    silent: opts.silent || false,
  };
  const exitCode = await exec.exec(cmd, args, options);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ---------------------------------------------------------------------------
// Utility: write a near-cli credentials file so near-cli can authenticate
// ---------------------------------------------------------------------------

function writeCredentials(accountId, privateKey, networkId = 'testnet') {
  // near-cli v4 looks for credentials in ~/.near-credentials/<network>/<account>.json
  const credDir = path.join(os.homedir(), '.near-credentials', networkId);
  fs.mkdirSync(credDir, { recursive: true });
  const credFile = path.join(credDir, `${accountId}.json`);

  // Derive the public key from the private key via near-cli's own format.
  // Private key format: "ed25519:<base58_secret>"
  // We store the pair so near-cli can read it.
  const credJson = {
    account_id: accountId,
    public_key: '', // will be populated after derivation step below
    private_key: privateKey,
  };

  // Temporarily write without public_key — we will update after we query the
  // actual public key from near-cli itself.
  fs.writeFileSync(credFile, JSON.stringify(credJson, null, 2));
  return credFile;
}

// ---------------------------------------------------------------------------
// Step 0: Install / verify near-cli v4 is available
// ---------------------------------------------------------------------------

async function ensureNearCli() {
  core.startGroup('🔧 Ensure near-cli is installed');
  try {
    const { exitCode, stdout } = await runCommand('near', ['--version'], { ignoreReturnCode: true, silent: true });
    if (exitCode === 0) {
      core.info(`near-cli already available: ${stdout}`);
    } else {
      throw new Error('near-cli not found, installing…');
    }
  } catch (_) {
    core.info('Installing near-cli globally via npm…');
    await runCommand('npm', ['install', '-g', 'near-cli'], { silent: false });
    const { stdout } = await runCommand('near', ['--version'], { silent: true });
    core.info(`near-cli installed: ${stdout}`);
  }
  core.endGroup();
}

// ---------------------------------------------------------------------------
// Step 1: Check whether the testnet account already exists via RPC
// ---------------------------------------------------------------------------

async function accountExists(accountId) {
  core.info(`Checking if account "${accountId}" exists on testnet…`);
  const rpcUrl = 'https://rpc.testnet.near.org';
  try {
    const resp = await jsonPost(rpcUrl, {
      jsonrpc: '2.0',
      id: 'dontcare',
      method: 'query',
      params: {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      },
    });
    const data = JSON.parse(resp.body);
    if (data.error) {
      // error code -32000 / UNKNOWN_ACCOUNT means account doesn't exist
      if (
        data.error.cause?.name === 'UNKNOWN_ACCOUNT' ||
        (data.error.data && String(data.error.data).includes('does not exist'))
      ) {
        return false;
      }
      // Any other RPC error — treat as unknown, let create attempt proceed
      core.warning(`RPC returned error while checking account: ${JSON.stringify(data.error)}`);
      return false;
    }
    return !!data.result;
  } catch (err) {
    core.warning(`Could not reach RPC to check account existence: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Create account via NEAR testnet helper API
// ---------------------------------------------------------------------------

async function createTestnetAccount(accountId, publicKey) {
  core.startGroup('🆕 Create testnet account');
  core.info(`Creating account "${accountId}" with public key "${publicKey}"…`);

  // The testnet account creation endpoint
  const helperUrl = 'https://helper.testnet.near.org/account';
  const payload = {
    newAccountId: accountId,
    newAccountPublicKey: publicKey,
  };

  const resp = await jsonPost(helperUrl, payload);
  core.info(`Helper response status: ${resp.statusCode}`);
  core.info(`Helper response body: ${resp.body}`);

  if (resp.statusCode !== 200 && resp.statusCode !== 201) {
    // Some versions of the helper return 200 with a JSON body indicating success
    let parsed;
    try { parsed = JSON.parse(resp.body); } catch (_) { parsed = null; }
    if (parsed && parsed.error) {
      throw new Error(`Account creation failed: ${parsed.error}`);
    }
    if (resp.statusCode >= 400) {
      throw new Error(
        `Account creation HTTP error ${resp.statusCode}: ${resp.body}`
      );
    }
  }

  core.info(`Account "${accountId}" created successfully.`);
  core.endGroup();
}

// ---------------------------------------------------------------------------
// Step 3: Request faucet funding
// ---------------------------------------------------------------------------

async function requestFaucetFunding(accountId, amountNear) {
  core.startGroup('💰 Request faucet funding');
  core.info(`Requesting ${amountNear} NEAR for account "${accountId}"…`);

  // NEAR testnet faucet helper — POST to /account with the account ID
  // The helper automatically tops up newly created accounts.
  // For an additional top-up we use the faucet endpoint.
  const faucetUrl = 'https://helper.testnet.near.org/account';
  const payload = { newAccountId: accountId, newAccountPublicKey: '' };

  // Primary: try the official wallet faucet endpoint
  try {
    const resp = await jsonPost(
      'https://faucet.nearprotocol.com/api/faucet',
      { account_id: accountId, amount: String(amountNear) }
    );
    core.info(`Faucet API status: ${resp.statusCode}`);
    if (resp.statusCode === 200 || resp.statusCode === 201) {
      core.info('Faucet funding request accepted.');
      core.endGroup();
      return;
    }
    core.warning(`Primary faucet returned ${resp.statusCode}: ${resp.body}`);
  } catch (err) {
    core.warning(`Primary faucet unreachable: ${err.message}`);
  }

  // Fallback: helper top-up for accounts that already exist
  try {
    const resp = await jsonPost(
      'https://helper.testnet.near.org/account',
      { newAccountId: accountId, newAccountPublicKey: 'ed25519:11111111111111111111111111111111' }
    );
    core.info(`Helper top-up status: ${resp.statusCode} — ${resp.body}`);
  } catch (err) {
    core.warning(`Helper top-up also failed: ${err.message}. Continuing — account may already have funds.`);
  }

  core.endGroup();
}

// ---------------------------------------------------------------------------
// Step 4: Derive the public key from the private key string using near-cli
// ---------------------------------------------------------------------------

async function derivePublicKey(privateKey, accountId, networkId = 'testnet') {
  // Write credential file with empty public key first
  const credDir = path.join(os.homedir(), '.near-credentials', networkId);
  fs.mkdirSync(credDir, { recursive: true });
  const credFile = path.join(credDir, `${accountId}.json`);
  fs.writeFileSync(
    credFile,
    JSON.stringify({ account_id: accountId, private_key: privateKey }, null, 2)
  );

  // near-cli v4: `near account` subcommand can print keys
  // We use `near keys <account>` or simply parse the key ourselves.
  // near-cli stores keys in ed25519:<base58> format; the public key is encoded
  // in the first 32 bytes of the full 64-byte keypair when using libsodium-style.
  // The safest approach: use the near-api-js KeyPair if available, else call near-cli.

  // Try using near-cli to generate a temp key file we can read
  const tmpKeyFile = path.join(os.tmpdir(), `near_tmp_key_${Date.now()}.json`);
  try {
    // near-cli v4 syntax
    await runCommand(
      'near',
      [
        'account', 'export-account', accountId,
        'using-private-key', privateKey,
        'network-config', networkId,
        '--format', 'json',
      ],
      { ignoreReturnCode: true, silent: true }
    );
  } catch (_) { /* ignore */ }

  // Fallback: parse key directly. NEAR private keys are base58-encoded
  // 64-byte seeds where bytes 32-63 are the public key (NaCl convention).
  // We use near-cli's `generate-key` style: treat private_key as a seed.
  // For real key derivation without native crypto, call near-cli:
  const { stdout, exitCode } = await runCommand(
    'near',
    ['generate-key', '--keyPath', tmpKeyFile],
    { ignoreReturnCode: true, silent: true }
  );

  // Actually the most reliable way: use Node's built-in or near-api-js.
  // Since we can't guarantee near-api-js, we'll use the @noble/ed25519 approach
  // via running a tiny node snippet:
  const scriptContent = `
    const { execSync } = require('child_process');
    // Try to load near-api-js if available
    let pk;
    try {
      const { KeyPair } = require('near-api-js');
      const kp = KeyPair.fromString(${JSON.stringify(privateKey)});
      pk = kp.getPublicKey().toString();
    } catch(e) {
      // Fallback: use tweetnacl if available
      try {
        const nacl = require('tweetnacl');
        const bs58 = require('bs58');
        const raw = ${JSON.stringify(privateKey)};
        const seed = bs58.decode(raw.replace('ed25519:', ''));
        const kp = nacl.sign.keyPair.fromSeed(seed.slice(0, 32));
        pk = 'ed25519:' + bs58.encode(Buffer.from(kp.publicKey));
      } catch(e2) {
        process.exit(1);
      }
    }
    process.stdout.write(pk);
  `;
  const scriptFile = path.join(os.tmpdir(), `derive_pk_${Date.now()}.js`);
  fs.writeFileSync(scriptFile, scriptContent);

  const { stdout: pkOut, exitCode: pkExit } = await runCommand(
    'node',
    [scriptFile],
    { ignoreReturnCode: true, silent: true }
  );

  // Clean up
  try { fs.unlinkSync(scriptFile); } catch (_) {}
  try { if (fs.existsSync(tmpKeyFile)) fs.unlinkSync(tmpKeyFile); } catch (_) {}

  if (pkExit === 0 && pkOut && pkOut.startsWith('ed25519:')) {
    // Update credentials file with actual public key
    fs.writeFileSync(
      credFile,
      JSON.stringify(
        { account_id: accountId, public_key: pkOut.trim(), private_key: privateKey },
        null, 2
      )
    );
    return pkOut.trim();
  }

  // Last resort: near-cli v3 `near keys` approach — just return empty and
  // let near-cli figure it out from the credentials file it reads
  core.warning('Could not derive public key programmatically; near-cli will use credentials file directly.');
  return '';
}

// ---------------------------------------------------------------------------
// Step 5: Find the WASM file to deploy
// ---------------------------------------------------------------------------

function findWasmFile(contractPath) {
  const resolved = path.resolve(contractPath);

  // If it's already a .wasm file, use it directly
  if (resolved.endsWith('.wasm') && fs.existsSync(resolved)) {
    core.info(`Using provided WASM file: ${resolved}`);
    return resolved;
  }

  // If it's a directory, search for WASM files in common locations
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const candidates = [
      path.join(resolved, 'target', 'wasm32-unknown-unknown', 'release'),
      path.join(resolved, 'res'),
      path.join(resolved, 'out'),
      path.join(resolved, 'build'),
      resolved,
    ];

    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wasm'));
      if (files.length > 0) {
        const found = path.join(dir, files[0]);
        core.info(`Found WASM at: ${found}`);
        return found;
      }
    }
  }

  throw new Error(
    `No WASM file found at "${contractPath}". ` +
    'Provide a direct .wasm path or ensure the contract is compiled.'
  );
}

// ---------------------------------------------------------------------------
// Step 6: Build the contract if needed (Rust / AssemblyScript / TypeScript)
// ---------------------------------------------------------------------------

async function buildContractIfNeeded(contractPath) {
  core.startGroup('🔨 Build contract (if needed)');

  const resolved = path.resolve(contractPath);

  // If a .wasm is provided directly, no build needed
  if (resolved.endsWith('.wasm') && fs.existsSync(resolved)) {
    core.info('WASM binary provided directly — skipping build step.');
    core.endGroup();
    return resolved;
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Contract path does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Expected a directory or .wasm file, got: ${resolved}`);
  }

  // Detect project type
  const hasCargoToml = fs.existsSync(path.join(resolved, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(resolved, 'package.json'));
  const hasAssemblyScript = fs.existsSync(path.join(resolved, 'assembly'));

  if (hasCargoToml) {
    core.info('Detected Rust contract. Building with cargo…');

    // Ensure wasm32 target
    await runCommand('rustup', ['target', 'add', 'wasm32-unknown-unknown']);

    // Build in release mode
    const { exitCode, stderr } = await runCommand(
      'cargo',
      ['build', '--target', 'wasm32-unknown-unknown', '--release'],
      { cwd: resolved }
    );
    if (exitCode !== 0) {
      throw new Error(`Rust build failed:\n${stderr}`);
    }
    core.info('Rust build succeeded.');
  } else if (hasAssemblyScript) {
    core.info('Detected AssemblyScript contract. Building with npm run build…');

    // Install dependencies first
    await runCommand('npm', ['install'], { cwd: resolved });
    const { exitCode, stderr } = await runCommand('npm', ['run', 'build'], { cwd: resolved });
    if (exitCode !== 0) {
      throw new Error(`AssemblyScript build failed:\n${stderr}`);
    }
  } else if (hasPackageJson) {
    core.info('Detected JS/TS contract. Running npm run build…');
    await runCommand('npm', ['install'], { cwd: resolved });
    const { exitCode, stderr } = await runCommand(
      'npm', ['run', 'build'], { cwd: resolved, ignoreReturnCode: true }
    );
    if (exitCode !== 0) {
      core.warning(`npm run build exited ${exitCode}: ${stderr}`);
    }
  } else {
    core.info('No recognizable build system found. Attempting to locate existing WASM…');
  }

  const wasmFile = findWasmFile(resolved);
  core.endGroup();
  return wasmFile;
}

// ---------------------------------------------------------------------------
// Step 7: Deploy contract using near-cli v4
// ---------------------------------------------------------------------------

async function deployContract(accountId, wasmFile, networkId = 'testnet') {
  core.startGroup('🚀 Deploy contract');
  core.info(`Deploying "${wasmFile}" to account "${accountId}" on ${networkId}…`);

  // near-cli v4 syntax: near contract deploy <account> use-file <wasm>
  // Fallback to v3 syntax if v4 is not recognised.
  let exitCode, stdout, stderr;

  // Try near-cli v4 syntax first
  ({ exitCode, stdout, stderr } = await runCommand(
    'near',
    [
      'contract', 'deploy', accountId,
      'use-file', wasmFile,
      'without-init-call',
      'network-config', networkId,
      'sign-with-keychain',
      'send',
    ],
    { ignoreReturnCode: true }
  ));

  if (exitCode !== 0) {
    core.warning(`near-cli v4 deploy failed (exit ${exitCode}), trying v3 syntax…`);
    core.warning(`stderr: ${stderr}`);

    // near-cli v3 syntax
    ({ exitCode, stdout, stderr } = await runCommand(
      'near',
      ['deploy', '--accountId', accountId, '--wasmFile', wasmFile, '--networkId', networkId],
      { ignoreReturnCode: true }
    ));
  }

  if (exitCode !== 0) {
    throw new Error(`Contract deployment failed (exit ${exitCode}):\n${stderr || stdout}`);
  }

  core.info(`Deploy output:\n${stdout}`);
  core.info('Contract deployed successfully.');
  core.endGroup();

  // Extract transaction hash if present
  const txHashMatch = stdout.match(/Transaction ID:\s*([A-Za-z0-9]+)/);
  return txHashMatch ? txHashMatch[1] : 'unknown';
}

// ---------------------------------------------------------------------------
// Step 8: Verify deployment via RPC (contract code exists)
// ---------------------------------------------------------------------------

async function verifyDeployment(accountId) {
  core.startGroup('✅ Verify deployment');
  core.info(`Verifying contract code is deployed on "${accountId}"…`);

  const rpcUrl = 'https://rpc.testnet.near.org';
  const resp = await jsonPost(rpcUrl, {
    jsonrpc: '2.0',
    id: 'dontcare',
    method: 'query',
    params: {
      request_type: 'view_code',
      finality: 'final',
      account_id: accountId,
    },
  });

  const data = JSON.parse(resp.body);
  if (data.error) {
    throw new Error(`RPC view_code error: ${JSON.stringify(data.error)}`);
  }

  const codeHash = data.result?.code_base64 ? '<binary present>' : data.result?.hash;
  core.info(`Contract code verified. Hash: ${data.result?.hash || 'n/a'}`);
  core.endGroup();
  return data.result?.hash || 'verified';
}

// ---------------------------------------------------------------------------
// Step 9: Run smoke tests
// ---------------------------------------------------------------------------

async function runSmokeTests(testScriptPath, accountId, networkId = 'testnet') {
  core.startGroup('🧪 Run smoke tests');

  const env = {
    NEAR_ACCOUNT_ID: accountId,
    NEAR_NETWORK_ID: networkId,
    NEAR_RPC_URL: 'https://rpc.testnet.near.org',
    CONTRACT_NAME: accountId,
    NODE_ENV: 'test',
  };

  core.info(`Running test command: ${testScriptPath}`);

  let exitCode, stdout, stderr;

  // Determine if testScriptPath is a file path or a shell command
  const isFilePath = testScriptPath.startsWith('./') ||
    testScriptPath.startsWith('/') ||
    fs.existsSync(path.resolve(testScriptPath));

  if (isFilePath) {
    const resolved = path.resolve(testScriptPath);
    if (!fs.existsSync(resolved)) {
      core.warning(`Test script not found at "${resolved}" — skipping tests.`);
      core.endGroup();
      return { passed: 0, failed: 0, skipped: 1,