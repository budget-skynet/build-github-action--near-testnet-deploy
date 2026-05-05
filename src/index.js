async function nearRpcCall(nodeUrl, method, params) {
  const payload = {
    jsonrpc: '2.0',
    id: 'dontcare',
    method,
    params,
  };
  const response = await jsonPost(nodeUrl, payload);
  const parsed = JSON.parse(response.body);
  if (parsed.error) {
    throw new Error(`RPC error (${method}): ${JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

// ─── Shell helpers ────────────────────────────────────────────────────────────

function run_cmd(command, options = {}) {
  core.info(`  $ ${command}`);
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 300000,
    });
    if (output && output.trim()) core.info(output.trim());
    return output.trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    if (stdout) core.info(stdout);
    if (stderr) core.error(stderr);
    throw new Error(`Command failed: ${command}\n${stderr || stdout}`);
  }
}

function run_cmd_result(command, options = {}) {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 300000,
    });
    return { success: true, stdout: output.trim(), stderr: '' };
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      stderr: err.stderr ? err.stderr.toString().trim() : '',
      code: err.status,
    };
  }
}

function toolExists(tool) {
  const result = run_cmd_result(`which ${tool}`);
  return result.success;
}

// ─── NEAR credential helpers ──────────────────────────────────────────────────

function getNearNodeUrl(network) {
  const urls = {
    testnet: 'https://rpc.testnet.near.org',
    mainnet: 'https://rpc.mainnet.near.org',
    betanet: 'https://rpc.betanet.near.org',
  };
  return urls[network] || urls.testnet;
}

function writeCredentials(accountId, privateKey, network) {
  const homeDir = os.homedir();
  const credDir = path.join(homeDir, '.near-credentials', network);
  fs.mkdirSync(credDir, { recursive: true });

  // Derive public key from private key using near-cli if available,
  // otherwise store what we have and rely on near-cli's key lookup.
  let publicKey = '';
  if (privateKey.startsWith('ed25519:')) {
    // Try to parse the public key portion; if we can't derive it, store a
    // placeholder – near-cli will use the full key material correctly.
    try {
      const { KeyPair } = require('near-api-js');
      const keyPair = KeyPair.fromString(privateKey);
      publicKey = keyPair.getPublicKey().toString();
    } catch (_) {
      publicKey = 'ed25519:' + Buffer.from(privateKey.replace('ed25519:', ''), 'base64').toString('hex').slice(0, 44);
    }
  }

  const credData = {
    account_id: accountId,
    public_key: publicKey,
    private_key: privateKey,
  };

  const credFile = path.join(credDir, `${accountId}.json`);
  fs.writeFileSync(credFile, JSON.stringify(credData, null, 2), { mode: 0o600 });
  core.info(`Credentials written to ${credFile}`);
  return credFile;
}

// ─── Step 1: Check / create testnet account ───────────────────────────────────

async function stepCreateOrVerifyAccount(accountId, privateKey, network, faucetUrl) {
  core.startGroup('Step 1 — Create / verify testnet account');

  const nodeUrl = getNearNodeUrl(network);
  core.info(`Checking account "${accountId}" on ${network} (${nodeUrl}) …`);

  let accountExists = false;
  try {
    const result = await nearRpcCall(nodeUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    core.info(`Account found. Balance: ${(BigInt(result.amount) / BigInt(1e24)).toString()} NEAR`);
    accountExists = true;
  } catch (err) {
    if (err.message.includes('does not exist') || err.message.includes('UnknownAccount')) {
      core.info(`Account "${accountId}" does not exist yet — will create it.`);
    } else {
      core.warning(`RPC check failed (${err.message}) — proceeding with creation attempt.`);
    }
  }

  if (!accountExists) {
    core.info(`Requesting account creation from faucet: ${faucetUrl}`);

    // Extract public key to send to faucet
    let publicKey = privateKey;
    try {
      const nearApiJs = requireSafe('near-api-js');
      if (nearApiJs) {
        const keyPair = nearApiJs.KeyPair.fromString(privateKey);
        publicKey = keyPair.getPublicKey().toString();
      }
    } catch (_) {}

    const faucetPayload = {
      newAccountId: accountId,
      newAccountPublicKey: publicKey,
    };

    try {
      const resp = await jsonPost(faucetUrl, faucetPayload, {
        'Accept': 'application/json',
      });
      core.info(`Faucet response [${resp.status}]: ${resp.body.slice(0, 500)}`);

      if (resp.status >= 200 && resp.status < 300) {
        core.info('Account creation request accepted by faucet.');
      } else {
        // Some helpers return 200 but with error text
        if (resp.body.toLowerCase().includes('error')) {
          core.warning(`Faucet may have returned an error: ${resp.body.slice(0, 200)}`);
        }
      }
    } catch (faucetErr) {
      // Try alternate faucet endpoint format
      core.warning(`Primary faucet call failed: ${faucetErr.message}. Trying alternate endpoint …`);
      const altUrl = faucetUrl.replace('/account', '') + '/create_account';
      try {
        const resp2 = await jsonPost(altUrl, faucetPayload);
        core.info(`Alt faucet response [${resp2.status}]: ${resp2.body.slice(0, 200)}`);
      } catch (altErr) {
        core.warning(`Alt faucet also failed: ${altErr.message}. Will proceed — account may already exist or CLI will handle it.`);
      }
    }

    // Wait for propagation
    core.info('Waiting 8 s for account propagation …');
    await sleep(8000);

    // Confirm creation
    let confirmed = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const r = await nearRpcCall(nodeUrl, 'query', {
          request_type: 'view_account',
          finality: 'final',
          account_id: accountId,
        });
        core.info(`Account confirmed on attempt ${attempt}. Balance: ${(BigInt(r.amount) / BigInt(1e24)).toString()} NEAR`);
        confirmed = true;
        break;
      } catch (_) {
        core.info(`Account not yet visible (attempt ${attempt}/6) — waiting 5 s …`);
        await sleep(5000);
      }
    }

    if (!confirmed) {
      throw new Error(`Account "${accountId}" could not be confirmed after faucet request. Check the faucet URL and account ID.`);
    }
  }

  // Write credentials for near-cli
  const credFile = writeCredentials(accountId, privateKey, network);

  core.endGroup();
  return { accountExists, credFile };
}

// ─── Step 2: Request faucet funding ──────────────────────────────────────────

async function stepFaucetFunding(accountId, privateKey, network, faucetUrl) {
  core.startGroup('Step 2 — Request faucet funding');

  const nodeUrl = getNearNodeUrl(network);

  // Check current balance
  let balanceBefore = BigInt(0);
  try {
    const result = await nearRpcCall(nodeUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    balanceBefore = BigInt(result.amount);
    const nearBalance = Number(balanceBefore / BigInt(1e21)) / 1000;
    core.info(`Balance before funding: ${nearBalance.toFixed(3)} NEAR`);

    // If balance is already above 5 NEAR, skip faucet
    if (balanceBefore >= BigInt(5) * BigInt(1e24)) {
      core.info('Balance is sufficient (≥ 5 NEAR). Skipping faucet request.');
      core.endGroup();
      return { funded: false, skipped: true, balanceBefore };
    }
  } catch (err) {
    core.warning(`Could not fetch balance: ${err.message}`);
  }

  core.info(`Requesting top-up from ${faucetUrl} …`);

  let publicKey = privateKey;
  try {
    const nearApiJs = requireSafe('near-api-js');
    if (nearApiJs) {
      const keyPair = nearApiJs.KeyPair.fromString(privateKey);
      publicKey = keyPair.getPublicKey().toString();
    }
  } catch (_) {}

  // Some faucets accept GET with query params; others accept POST JSON
  const payloads = [
    { url: faucetUrl, method: 'POST', body: { newAccountId: accountId, newAccountPublicKey: publicKey } },
    { url: `${faucetUrl}?account_id=${encodeURIComponent(accountId)}`, method: 'GET', body: null },
  ];

  let funded = false;
  for (const attempt of payloads) {
    try {
      let resp;
      if (attempt.method === 'POST') {
        resp = await jsonPost(attempt.url, attempt.body);
      } else {
        resp = await httpRequest(attempt.url, { method: 'GET' });
      }
      core.info(`Faucet response [${resp.status}]: ${resp.body.slice(0, 300)}`);
      if (resp.status >= 200 && resp.status < 300) {
        funded = true;
        break;
      }
    } catch (e) {
      core.warning(`Faucet attempt failed: ${e.message}`);
    }
  }

  if (funded) {
    core.info('Faucet request sent. Waiting 10 s for funds to arrive …');
    await sleep(10000);

    try {
      const result = await nearRpcCall(nodeUrl, 'query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      const balanceAfter = BigInt(result.amount);
      const nearBalance = Number(balanceAfter / BigInt(1e21)) / 1000;
      core.info(`Balance after funding: ${nearBalance.toFixed(3)} NEAR`);
    } catch (_) {}
  } else {
    core.warning('Could not confirm faucet funding. Proceeding — deploy may fail if balance is too low.');
  }

  core.endGroup();
  return { funded, skipped: false, balanceBefore };
}

// ─── Step 3: Build & deploy contract ─────────────────────────────────────────

async function stepDeployContract(contractPath, accountId, privateKey, network) {
  core.startGroup('Step 3 — Build & deploy contract');

  const nodeUrl = getNearNodeUrl(network);
  const resolvedPath = path.resolve(contractPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`contract_path "${resolvedPath}" does not exist.`);
  }

  const stat = fs.statSync(resolvedPath);
  let wasmPath = null;

  // ── Determine if we have a pre-built .wasm or need to build ──────────────
  if (stat.isFile() && resolvedPath.endsWith('.wasm')) {
    wasmPath = resolvedPath;
    core.info(`Pre-built WASM found: ${wasmPath}`);
  } else {
    // It's a directory — detect project type and build
    const projectDir = stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
    core.info(`Building contract in ${projectDir} …`);
    wasmPath = await buildContract(projectDir);
  }

  // ── Deploy via near-cli or near-api-js ────────────────────────────────────
  const wasmSize = fs.statSync(wasmPath).size;
  core.info(`Deploying ${wasmPath} (${(wasmSize / 1024).toFixed(1)} KB) to ${accountId} on ${network} …`);

  // Try near-cli first (most reliable for deploying)
  const nearCliResult = await deployWithNearCli(wasmPath, accountId, network, privateKey);

  let txHash = null;

  if (!nearCliResult.success) {
    core.warning(`near-cli deploy failed: ${nearCliResult.error}. Falling back to near-api-js …`);
    txHash = await deployWithNearApiJs(wasmPath, accountId, privateKey, nodeUrl);
  } else {
    txHash = nearCliResult.txHash;
    core.info(`near-cli deploy succeeded. TX: ${nearCliResult.txHash || 'N/A'}`);
  }

  // ── Verify deployment ─────────────────────────────────────────────────────
  core.info('Verifying deployment via RPC …');
  await sleep(3000);

  let deployConfirmed = false;
  for (let i = 1; i <= 5; i++) {
    try {
      const result = await nearRpcCall(nodeUrl, 'query', {
        request_type: 'view_code',
        finality: 'final',
        account_id: accountId,
      });
      if (result.code_base64 && result.code_base64.length > 10) {
        const deployedSize = Buffer.from(result.code_base64, 'base64').length;
        core.info(`Contract deployed and verified. On-chain size: ${(deployedSize / 1024).toFixed(1)} KB`);
        deployConfirmed = true;
        break;
      }
    } catch (err) {
      core.info(`Verification attempt ${i}/5 failed: ${err.message}. Retrying in 4 s …`);
      await sleep(4000);
    }
  }

  if (!deployConfirmed) {
    throw new Error('Contract deployment could not be verified via view_code RPC after 5 attempts.');
  }

  core.endGroup();
  return { wasmPath, txHash, deployConfirmed };
}

async function buildContract(projectDir) {
  const cargoToml = path.join(projectDir, 'Cargo.toml');
  const packageJson = path.join(projectDir, 'package.json');
  const assemblyscriptConfig = path.join(projectDir, 'asconfig.json');

  if (fs.existsSync(cargoToml)) {
    return buildRust(projectDir, cargoToml);
  } else if (fs.existsSync(assemblyscriptConfig)) {
    return buildAssemblyScript(projectDir);
  } else if (fs.existsSync(packageJson)) {
    return buildJavaScriptContract(projectDir);
  } else {
    throw new Error(`Cannot determine contract type in ${projectDir}. Expected Cargo.toml, asconfig.json, or package.json.`);
  }
}

async function buildRust(projectDir, cargoToml) {
  core.info('Detected Rust contract (Cargo.toml found).');

  // Ensure wasm32 target
  const rustupResult = run_cmd_result('rustup target list --installed');
  if (!rustupResult.stdout.includes('wasm32-unknown-unknown')) {
    core.info('Adding wasm32-unknown-unknown target …');
    run_cmd('rustup target add wasm32-unknown-unknown');
  }

  // Check for near-sdk build script or just use cargo build
  const buildScript = path.join(projectDir, 'build.sh');
  if (fs.existsSync(buildScript)) {
    core.info('Using project build.sh …');
    run_cmd(`bash ${buildScript}`, { cwd: projectDir });
  } else {
    run_cmd(
      'cargo build --target wasm32-unknown-unknown --release',
      { cwd: projectDir }
    );
  }

  // Locate the .wasm output
  const wasmDir = path.join(projectDir, 'target', 'wasm32-unknown-unknown', 'release');
  if (!fs.existsSync(wasmDir)) {
    throw new Error(`Expected wasm output directory not found: ${wasmDir}`);
  }

  const wasmFiles = fs.readdirSync(wasmDir).filter((f) => f.endsWith('.wasm'));
  if (wasmFiles.length === 0) {
    throw new Error(`No .wasm file found in ${wasmDir} after build.`);
  }

  // Pick the largest .wasm (usually the main contract, not dependencies)
  wasmFiles.sort((a, b) => {
    return fs.statSync(path.join(wasmDir, b)).size - fs.statSync(path.join(wasmDir, a)).size;
  });

  const wasmPath = path.join(wasmDir, wasmFiles[0]);
  core.info(`Built WASM: ${wasmPath} (${(fs.statSync(wasmPath).size / 1024).toFixed(1)} KB)`);
  return wasmPath;
}

async function buildAssemblyScript(projectDir) {
  core.info('Detected AssemblyScript contract (asconfig.json found).');

  const pkgJson = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgJson)) {
    run_cmd('npm install', { cwd: projectDir });
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    if (pkg.scripts && pkg.scripts.build) {
      run_cmd('npm run build', { cwd: projectDir });
    } else {
      run_cmd('npx asc assembly/index.ts --target release', { cwd: projectDir });
    }
  } else {
    run_cmd('npx asc assembly/index.ts --target release', { cwd: projectDir });
  }

  // Common output locations
  const candidates = [
    path.join(projectDir, 'build', 'release', 'contract.wasm'),
    path.join(projectDir, 'build', 'contract.wasm'),
    path.join(projectDir, 'out', 'main.wasm'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Search recursively
  const found = findWasm(projectDir);
  if (found) return found;

  throw new Error('Could not locate compiled .wasm after AssemblyScript build.');
}

async function buildJavaScriptContract(projectDir) {
  core.info('Detected JavaScript/TypeScript contract (package.json found).');

  run_cmd('npm install', { cwd: projectDir });

  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  if (pkg.scripts && pkg.scripts.build) {
    run_cmd('npm run build', { cwd: projectDir });
  } else {
    // Try near-sdk-js build
    run_cmd('npx near-sdk-js build', { cwd: projectDir });
  }

  const found = findWasm(projectDir);
  if (found) return found;

  throw new Error('Could not locate compiled .wasm after JS contract build.');
}

function findWasm(dir, depth = 0) {
  if (depth > 6) return null;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {