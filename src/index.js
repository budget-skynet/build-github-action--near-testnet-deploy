async function nearRpcCall(method, params) {
  const body = {
    jsonrpc: '2.0',
    id: 'dontcare',
    method,
    params,
  };
  const payload = JSON.stringify(body);
  const options = {
    hostname: 'rpc.testnet.near.org',
    port: 443,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };
  const response = await httpsRequest(options, payload);
  if (!response.body) {
    throw new Error(`RPC call failed with status ${response.status}: ${response.raw}`);
  }
  if (response.body.error) {
    throw new Error(`RPC error: ${JSON.stringify(response.body.error)}`);
  }
  return response.body.result;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function runCommand(cmd, options = {}) {
  const opts = {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 300000,
    ...options,
  };
  core.debug(`Running: ${cmd}`);
  try {
    const output = execSync(cmd, opts);
    return { success: true, output: output ? output.toString().trim() : '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout ? err.stdout.toString().trim() : '',
      error: err.stderr ? err.stderr.toString().trim() : err.message,
      exitCode: err.status,
    };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nearTokensToYocto(near) {
  const nearNum = parseFloat(near);
  // 1 NEAR = 10^24 yoctoNEAR
  // Use BigInt arithmetic to avoid floating-point issues
  const yoctoPerNear = BigInt('1000000000000000000000000');
  const wholeNear = Math.floor(nearNum);
  const fractional = nearNum - wholeNear;
  const yocto = BigInt(wholeNear) * yoctoPerNear + BigInt(Math.round(fractional * 1e24));
  return yocto.toString();
}

function formatNEAR(yoctoStr) {
  try {
    const yocto = BigInt(yoctoStr);
    const yoctoPerNear = BigInt('1000000000000000000000000');
    const whole = yocto / yoctoPerNear;
    const frac = yocto % yoctoPerNear;
    const fracStr = frac.toString().padStart(24, '0').slice(0, 4);
    return `${whole}.${fracStr} NEAR`;
  } catch {
    return `${yoctoStr} yoctoNEAR`;
  }
}

// ─── NEAR Key utilities ───────────────────────────────────────────────────────

function parsePrivateKey(privateKeyRaw) {
  // Accepts "ed25519:BASE58KEY" or raw base58
  const stripped = privateKeyRaw.startsWith('ed25519:')
    ? privateKeyRaw.slice(8)
    : privateKeyRaw;
  return stripped;
}

function writeNearCredentials(accountId, privateKey) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
  const credDir = path.join(homeDir, '.near-credentials', 'testnet');
  fs.mkdirSync(credDir, { recursive: true });

  const keyStripped = parsePrivateKey(privateKey);
  // Derive the public key using near-api-js or write as-is for NEAR CLI
  const credFile = path.join(credDir, `${accountId}.json`);
  const credContent = {
    account_id: accountId,
    public_key: '', // will be filled from NEAR CLI if available
    private_key: `ed25519:${keyStripped}`,
  };

  // Try to get public key via near-api-js if available
  try {
    const nacl = require('tweetnacl');
    const bs58 = require('bs58');
    const secretKeyBytes = bs58.decode(keyStripped);
    const keypair = nacl.sign.keyPair.fromSecretKey(
      secretKeyBytes.length === 64 ? secretKeyBytes : secretKeyBytes.slice(0, 32)
    );
    const publicKeyB58 = bs58.encode(keypair.publicKey);
    credContent.public_key = `ed25519:${publicKeyB58}`;
  } catch {
    core.debug('tweetnacl/bs58 not available, using NEAR CLI for key derivation');
  }

  fs.writeFileSync(credFile, JSON.stringify(credContent, null, 2));
  core.debug(`Credentials written to ${credFile}`);
  return credFile;
}

// ─── Step 1: Check / Auto-create testnet account ──────────────────────────────

async function checkAccountExists(accountId) {
  core.info(`🔍 Checking if account '${accountId}' exists on testnet...`);
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    core.info(`✅ Account exists. Balance: ${formatNEAR(result.amount)}`);
    return { exists: true, balance: result.amount, storageUsage: result.storage_usage };
  } catch (err) {
    if (err.message.includes('does not exist') || err.message.includes('UNKNOWN_ACCOUNT')) {
      core.info(`ℹ️  Account '${accountId}' does not exist yet.`);
      return { exists: false, balance: '0', storageUsage: 0 };
    }
    throw err;
  }
}

async function createTestnetAccount(accountId) {
  core.info(`🆕 Creating testnet account '${accountId}'...`);

  // Method 1: Try NEAR testnet faucet account creator
  const payload = JSON.stringify({ newAccountId: accountId, newAccountPublicKey: '' });

  // Try the helper contract on testnet — standard account creation pattern
  // For testnet we use the testnet.near account to create subaccounts
  // or use the wallet API
  const createOptions = {
    hostname: 'helper.testnet.near.org',
    port: 443,
    path: '/account',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  try {
    const response = await httpsRequest(createOptions, payload);
    if (response.status === 200) {
      core.info(`✅ Account '${accountId}' created via testnet helper.`);
      return true;
    }
    core.warning(`Helper returned status ${response.status}: ${response.raw}`);
  } catch (err) {
    core.warning(`Testnet helper unavailable: ${err.message}`);
  }

  // Method 2: Use NEAR CLI to create account
  const nearCliResult = runCommand(
    `near account create-account fund-myself ${accountId} '10 NEAR' autogenerate-new-key save-to-legacy-keychain network-config testnet create`,
    { timeout: 60000 }
  );
  if (nearCliResult.success) {
    core.info(`✅ Account created via NEAR CLI.`);
    return true;
  }

  // Method 3: Use older near-cli syntax
  const oldCliResult = runCommand(
    `near create-account ${accountId} --masterAccount testnet --initialBalance 10 --networkId testnet`,
    { timeout: 60000 }
  );
  if (oldCliResult.success) {
    core.info(`✅ Account created via near-cli (legacy).`);
    return true;
  }

  throw new Error(
    `Failed to create account '${accountId}'. Ensure the account ID is valid for testnet ` +
    `(e.g., 'yourname.testnet') and the account does not already exist under a different key.`
  );
}

async function ensureAccountExists(accountId, privateKey) {
  core.startGroup('📋 Step 1: Verify / Create Testnet Account');
  const accountInfo = await checkAccountExists(accountId);

  if (!accountInfo.exists) {
    await createTestnetAccount(accountId);
    // Verify creation
    await sleep(3000);
    const verify = await checkAccountExists(accountId);
    if (!verify.exists) {
      throw new Error(`Account creation reported success but account '${accountId}' still not found.`);
    }
    accountInfo.exists = true;
    accountInfo.balance = verify.balance;
  }

  // Write credentials for NEAR CLI
  writeNearCredentials(accountId, privateKey);
  core.info(`🔑 Credentials configured for account '${accountId}'.`);
  core.setOutput('account_id', accountId);
  core.endGroup();

  return { accountId, balance: accountInfo.balance };
}

// ─── Step 2: Request faucet funding ──────────────────────────────────────────

async function requestFaucetFunding(accountId, faucetAmount) {
  core.startGroup('💰 Step 2: Request Faucet Funding');
  const amount = parseFloat(faucetAmount) || 10;
  core.info(`💧 Requesting ${amount} NEAR for account '${accountId}'...`);

  // Check current balance first
  let currentBalanceYocto = '0';
  try {
    const acctResult = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    currentBalanceYocto = acctResult.amount;
    core.info(`Current balance: ${formatNEAR(currentBalanceYocto)}`);
  } catch {
    core.warning('Could not fetch current balance.');
  }

  // Try neardev faucet
  const faucetPayload = JSON.stringify({
    accountId,
    amount: amount.toString(),
  });

  const faucetEndpoints = [
    {
      hostname: 'near-faucet.onrender.com',
      path: '/api/faucet',
      method: 'POST',
    },
    {
      hostname: 'helper.testnet.near.org',
      path: '/account',
      method: 'POST',
    },
  ];

  let funded = false;
  for (const endpoint of faucetEndpoints) {
    try {
      const options = {
        ...endpoint,
        port: 443,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(faucetPayload),
        },
      };
      const response = await httpsRequest(options, faucetPayload);
      if (response.status >= 200 && response.status < 300) {
        core.info(`✅ Faucet request successful via ${endpoint.hostname}.`);
        funded = true;
        break;
      }
      core.debug(`Faucet ${endpoint.hostname} returned ${response.status}`);
    } catch (err) {
      core.debug(`Faucet ${endpoint.hostname} error: ${err.message}`);
    }
  }

  // Try NEAR CLI faucet command if endpoints failed
  if (!funded) {
    core.info('Trying NEAR CLI faucet approach...');
    const cliResult = runCommand(
      `near tokens ${accountId} request-add NEAR '${amount} NEAR' network-config testnet sign-with-legacy-keychain send`,
      { timeout: 60000 }
    );
    if (cliResult.success) {
      funded = true;
      core.info('✅ Funded via NEAR CLI tokens command.');
    } else {
      core.warning(
        `Faucet funding may not have completed. The account may already have sufficient balance. ` +
        `Error: ${cliResult.error}`
      );
    }
  }

  // Wait for balance to update
  await sleep(5000);

  // Verify updated balance
  let newBalance = currentBalanceYocto;
  try {
    const acctResult = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    newBalance = acctResult.amount;
    core.info(`Updated balance: ${formatNEAR(newBalance)}`);
  } catch {
    core.warning('Could not verify updated balance.');
  }

  const minRequired = nearTokensToYocto('1');
  if (BigInt(newBalance) < BigInt(minRequired)) {
    throw new Error(
      `Account balance (${formatNEAR(newBalance)}) is insufficient for deployment. ` +
      `Please ensure the account has at least 1 NEAR.`
    );
  }

  core.setOutput('funded_balance', formatNEAR(newBalance));
  core.endGroup();
  return { balance: newBalance, funded };
}

// ─── Step 3: Build / Prepare the contract ────────────────────────────────────

async function prepareContract(contractPath) {
  core.startGroup('🏗️  Step 3: Prepare Contract');
  core.info(`📂 Contract path: ${contractPath}`);

  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract path does not exist: ${contractPath}`);
  }

  const stat = fs.statSync(contractPath);
  let wasmPath;

  if (stat.isFile() && contractPath.endsWith('.wasm')) {
    // Already a compiled WASM file
    core.info('📦 Pre-compiled WASM file detected, skipping build.');
    wasmPath = contractPath;
  } else if (stat.isDirectory()) {
    // Source directory — need to build
    core.info('🔨 Source directory detected, building contract...');

    const packageJsonPath = path.join(contractPath, 'package.json');
    const cargoTomlPath = path.join(contractPath, 'Cargo.toml');

    if (fs.existsSync(cargoTomlPath)) {
      // Rust contract
      core.info('🦀 Rust contract detected.');
      wasmPath = await buildRustContract(contractPath);
    } else if (fs.existsSync(packageJsonPath)) {
      // JavaScript/AssemblyScript contract
      core.info('📜 JS/AssemblyScript contract detected.');
      wasmPath = await buildJsContract(contractPath);
    } else {
      throw new Error(
        `Cannot determine contract type in '${contractPath}'. ` +
        `Expected Cargo.toml (Rust) or package.json (JS/AssemblyScript).`
      );
    }
  } else {
    throw new Error(
      `Contract path '${contractPath}' is neither a directory nor a .wasm file.`
    );
  }

  // Validate WASM file
  const wasmBuffer = fs.readFileSync(wasmPath);
  const magic = wasmBuffer.slice(0, 4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new Error(`File '${wasmPath}' does not appear to be a valid WASM binary.`);
  }

  const sizeMB = (wasmBuffer.length / 1024 / 1024).toFixed(2);
  core.info(`✅ WASM ready: ${wasmPath} (${sizeMB} MB)`);

  // NEAR has a 4MB contract size limit
  if (wasmBuffer.length > 4 * 1024 * 1024) {
    throw new Error(
      `Contract WASM (${sizeMB} MB) exceeds NEAR's 4 MB limit. ` +
      `Consider using wasm-opt to reduce size.`
    );
  }

  core.setOutput('wasm_path', wasmPath);
  core.setOutput('wasm_size_bytes', wasmBuffer.length.toString());
  core.endGroup();

  return { wasmPath, wasmSize: wasmBuffer.length };
}

async function buildRustContract(contractDir) {
  // Install wasm target if needed
  const rustupResult = runCommand('rustup target add wasm32-unknown-unknown', { timeout: 120000 });
  if (!rustupResult.success) {
    core.warning(`rustup target add: ${rustupResult.error}`);
  }

  // Try cargo-near first
  const cargoNearCheck = runCommand('cargo near --version');
  if (cargoNearCheck.success) {
    core.info('Using cargo-near to build...');
    const buildResult = runCommand(
      `cd "${contractDir}" && cargo near build non-reproducible-wasm`,
      { timeout: 300000 }
    );
    if (buildResult.success) {
      // Find the built WASM
      const findResult = runCommand(
        `find "${contractDir}/target" -name "*.wasm" -not -path "*/deps/*" | head -1`
      );
      if (findResult.success && findResult.output) {
        return findResult.output.trim();
      }
    }
  }

  // Standard cargo build
  core.info('Using cargo build...');
  const buildResult = runCommand(
    `cd "${contractDir}" && cargo build --target wasm32-unknown-unknown --release`,
    { timeout: 300000 }
  );
  if (!buildResult.success) {
    throw new Error(`Rust build failed:\n${buildResult.error}\n${buildResult.output}`);
  }

  // Find the WASM in target directory
  const findResult = runCommand(
    `find "${contractDir}/target/wasm32-unknown-unknown/release" -name "*.wasm" -not -name "*-*" | head -1`
  );
  if (!findResult.success || !findResult.output) {
    const findAll = runCommand(
      `find "${contractDir}/target" -name "*.wasm" | grep release | head -1`
    );
    if (!findAll.success || !findAll.output) {
      throw new Error('Could not locate built WASM file after cargo build.');
    }
    return findAll.output.trim();
  }

  // Optionally run wasm-opt
  const wasmPath = findResult.output.trim();
  const wasmOptCheck = runCommand('wasm-opt --version');
  if (wasmOptCheck.success) {
    const optimizedPath = wasmPath.replace('.wasm', '_optimized.wasm');
    const optResult = runCommand(
      `wasm-opt -Oz "${wasmPath}" -o "${optimizedPath}"`,
      { timeout: 120000 }
    );
    if (optResult.success && fs.existsSync(optimizedPath)) {
      core.info('✅ WASM optimized with wasm-opt.');
      return optimizedPath;
    }
  }

  return wasmPath;
}

async function buildJsContract(contractDir) {
  // Install dependencies
  const packageJsonPath = path.join(contractDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  const yarnLock = fs.existsSync(path.join(contractDir, 'yarn.lock'));
  const installCmd = yarnLock ? 'yarn install --frozen-lockfile' : 'npm ci || npm install';
  const installResult = runCommand(`cd "${contractDir}" && ${installCmd}`, { timeout: 120000 });
  if (!installResult.success) {
    core.warning(`Dependency install warnings: ${installResult.error}`);
  }

  // Check for build scripts
  const scripts = packageJson.scripts || {};
  let buildCmd;
  if (scripts.build) {
    buildCmd = yarnLock ? 'yarn build' : 'npm run build';
  } else if (scripts['build:contract']) {
    buildCmd = yarnLock ? 'yarn build:contract' : 'npm run build:contract';
  } else {
    // Try AssemblyScript
    const asCheck = runCommand('npx asc --version');
    if (asCheck.success) {
      const mainFile = path.join(contractDir, 'assembly', 'index.ts');
      if (fs.existsSync(mainFile)) {
        buildCmd = `npx asc "${mainFile}" --target release --outFile build/contract.wasm --optimize`;
      }
    }
  }

  if (!buildCmd) {
    throw new Error(
      `No build script found in package.json for JS contract at '${contractDir}'. ` +
      `Add a 'build' script that produces a .wasm file.`
    );
  }

  const buildResult = runCommand(`cd "${contractDir}" && ${buildCmd}`, { timeout