async function nearRpc(rpcUrl, method, params) {
  const body = {
    jsonrpc: '2.0',
    id: `near-action-${Date.now()}`,
    method,
    params,
  };

  core.debug(`RPC → ${rpcUrl}  method=${method}  params=${JSON.stringify(params)}`);

  const response = await httpRequest(rpcUrl, 'POST', body, {}, 30000);

  if (response.status !== 200) {
    throw new Error(
      `RPC HTTP ${response.status} for method "${method}": ${response.body.slice(0, 300)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error(`RPC returned non-JSON for method "${method}": ${response.body.slice(0, 300)}`);
  }

  if (parsed.error) {
    throw new Error(
      `RPC error for method "${method}": [${parsed.error.code}] ${parsed.error.message} — ${JSON.stringify(parsed.error.data)}`
    );
  }

  return parsed.result;
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------
async function withRetry(label, fn, retries = 3, delayMs = 4000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      core.warning(`${label} — attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${delayMs}ms…`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// base58 encode/decode (minimal, for ed25519 key handling)
// ---------------------------------------------------------------------------
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let num = BigInt('0x' + bytes.toString('hex'));
  const base = BigInt(58);
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % base)] + result;
    num /= base;
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}

function base58Decode(str) {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  const leadingZeros = [...str].filter((c, i) => c === '1' && i < str.length - 1).length;
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

// ---------------------------------------------------------------------------
// Key utilities
// ---------------------------------------------------------------------------
function parsePrivateKey(rawKey) {
  // Accept "ed25519:<base58>" or plain base58 or hex
  let keyMaterial = rawKey.trim();

  if (keyMaterial.startsWith('ed25519:')) {
    keyMaterial = keyMaterial.slice('ed25519:'.length);
  }

  let secretBytes;
  try {
    const decoded = base58Decode(keyMaterial);
    // NEAR private keys: first 32 bytes = private key seed, next 32 = public key
    secretBytes = decoded.slice(0, 32);
  } catch {
    // Try hex
    secretBytes = Buffer.from(keyMaterial, 'hex').slice(0, 32);
  }

  if (secretBytes.length !== 32) {
    throw new Error(
      `Cannot parse private key — expected 32-byte seed, got ${secretBytes.length} bytes`
    );
  }

  return secretBytes;
}

function derivePublicKey(privateKeySeed) {
  // Node ≥ 15 has webcrypto; use built-in ed25519 via createPrivateKey
  // We use the "raw" approach: generate keypair from seed
  const { generateKeyPairSync } = require('crypto');

  // Node's crypto doesn't expose raw ed25519 seed generation directly in all
  // versions, so we use the DER-encoded approach with the PKCS8 format.
  // PKCS8 header for ed25519: 302e020100300506032b657004220420 + 32-byte seed
  const header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([header, privateKeySeed]);

  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);

  // Export public key as SubjectPublicKeyInfo DER — last 32 bytes are the raw key
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = pubDer.slice(-32);

  return rawPub;
}

function signPayload(payload, privateKeySeed) {
  // payload is a Buffer / Uint8Array
  const { generateKeyPairSync, sign } = require('crypto');

  const header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([header, privateKeySeed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  const signature = crypto.sign(null, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), privateKey);
  return signature; // 64-byte Buffer
}

// ---------------------------------------------------------------------------
// NEAR transaction serialisation (Borsh-lite — only what we need)
// ---------------------------------------------------------------------------
// We implement just enough Borsh to build and sign NEAR transactions.

class BorshWriter {
  constructor() { this.buf = []; }

  writeU8(v) { this.buf.push(v & 0xff); }

  writeU32(v) {
    this.buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  writeU64(v) {
    // v can be BigInt or number
    const big = BigInt(v);
    const lo = big & 0xffffffffn;
    const hi = (big >> 32n) & 0xffffffffn;
    this.writeU32(Number(lo));
    this.writeU32(Number(hi));
  }

  writeU128(v) {
    const big = BigInt(v);
    const lo = big & 0xffffffffffffffffn;
    const hi = (big >> 64n) & 0xffffffffffffffffn;
    this.writeU64(lo);
    this.writeU64(hi);
  }

  writeBytes(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.writeU32(b.length);
    for (const byte of b) this.buf.push(byte);
  }

  writeRawBytes(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    for (const byte of b) this.buf.push(byte);
  }

  writeString(s) {
    const encoded = Buffer.from(s, 'utf8');
    this.writeU32(encoded.length);
    this.writeRawBytes(encoded);
  }

  toBuffer() { return Buffer.from(this.buf); }
}

function serializePublicKey(rawPubBytes) {
  // KeyType::ED25519 = 0
  const w = new BorshWriter();
  w.writeU8(0); // ED25519
  w.writeRawBytes(rawPubBytes); // 32 bytes
  return w.toBuffer();
}

function serializeAction(action) {
  const w = new BorshWriter();
  switch (action.type) {
    case 'CreateAccount':
      w.writeU8(0);
      break;
    case 'Transfer':
      w.writeU8(3);
      w.writeU128(action.deposit);
      break;
    case 'DeployContract':
      w.writeU8(7);
      w.writeBytes(action.code);
      break;
    case 'FunctionCall':
      w.writeU8(2);
      w.writeString(action.methodName);
      w.writeBytes(Buffer.from(JSON.stringify(action.args || {}), 'utf8'));
      w.writeU64(action.gas || 30000000000000n);
      w.writeU128(action.deposit || 0n);
      break;
    case 'AddKey':
      w.writeU8(5);
      w.writeRawBytes(serializePublicKey(action.publicKey));
      // AccessKey
      w.writeU64(action.nonce || 0);
      if (action.permission === 'FullAccess') {
        w.writeU8(1); // FullAccess
      } else {
        w.writeU8(0); // FunctionCall permission
        w.writeU128(action.allowance || 0n);
        w.writeString(action.receiverId || '');
        // method names array
        const methods = action.methodNames || [];
        w.writeU32(methods.length);
        for (const m of methods) w.writeString(m);
      }
      break;
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
  return w.toBuffer();
}

function serializeTransaction(tx) {
  // tx: { signerId, publicKey (raw bytes), nonce, receiverId, blockHash (Buffer), actions[] }
  const w = new BorshWriter();
  w.writeString(tx.signerId);
  w.writeRawBytes(serializePublicKey(tx.publicKey));
  w.writeU64(tx.nonce);
  w.writeString(tx.receiverId);
  w.writeRawBytes(tx.blockHash); // 32 bytes raw
  w.writeU32(tx.actions.length);
  for (const action of tx.actions) {
    w.writeRawBytes(serializeAction(action));
  }
  return w.toBuffer();
}

function buildSignedTransaction(txBytes, signatureBytes, publicKeyBytes) {
  // SignedTransaction { transaction, signature }
  const w = new BorshWriter();
  w.writeRawBytes(txBytes);
  // Signature { keyType: ED25519=0, data: 64 bytes }
  w.writeU8(0);
  w.writeRawBytes(signatureBytes);
  return w.toBuffer();
}

// ---------------------------------------------------------------------------
// Send a signed transaction via RPC
// ---------------------------------------------------------------------------
async function sendTransaction(rpcUrl, signedTxBytes) {
  const base64Tx = signedTxBytes.toString('base64');
  return nearRpc(rpcUrl, 'broadcast_tx_commit', [base64Tx]);
}

// ---------------------------------------------------------------------------
// Build a transaction, sign it, and broadcast it
// ---------------------------------------------------------------------------
async function buildSignAndSend(rpcUrl, {
  signerId,
  signerPrivateSeed,
  signerPublicKeyBytes,
  receiverId,
  actions,
  nonce,         // optional — fetched if omitted
  blockHash,     // optional — fetched if omitted
}) {
  // Fetch access key info if nonce/blockHash not provided
  let resolvedNonce = nonce;
  let resolvedBlockHash = blockHash;

  const pubKeyB58 = 'ed25519:' + base58Encode(signerPublicKeyBytes);

  if (resolvedNonce === undefined || resolvedBlockHash === undefined) {
    const akResult = await nearRpc(rpcUrl, 'query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: signerId,
      public_key: pubKeyB58,
    });
    resolvedNonce = BigInt(akResult.nonce) + 1n;

    // blockHash comes back as base58
    resolvedBlockHash = base58Decode(akResult.block_hash);
  }

  const txBytes = serializeTransaction({
    signerId,
    publicKey: signerPublicKeyBytes,
    nonce: resolvedNonce,
    receiverId,
    blockHash: resolvedBlockHash,
    actions,
  });

  // Hash the serialised transaction with SHA-256, then sign
  const txHash = crypto.createHash('sha256').update(txBytes).digest();
  const sigBytes = signPayload(txHash, signerPrivateSeed);

  const signedBytes = buildSignedTransaction(txBytes, sigBytes, signerPublicKeyBytes);
  return sendTransaction(rpcUrl, signedBytes);
}

// ---------------------------------------------------------------------------
// Account existence check
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
    if (
      err.message.includes('does not exist') ||
      err.message.includes('UnknownAccount') ||
      err.message.includes('AccountDoesNotExist')
    ) {
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Get account balance (returns yoctoNEAR as string)
// ---------------------------------------------------------------------------
async function getAccountBalance(rpcUrl, accountId) {
  const result = await nearRpc(rpcUrl, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });
  return result.amount; // yoctoNEAR string
}

// ---------------------------------------------------------------------------
// STEP 1 — Create testnet account via helper contract if it doesn't exist
// ---------------------------------------------------------------------------
async function stepCreateAccount(ctx) {
  return logGroup('Step 1 — Create / Verify Account', async () => {
    const { rpcUrl, accountId, publicKeyBytes } = ctx;

    const exists = await withRetry(
      'accountExists',
      () => accountExists(rpcUrl, accountId),
      3,
      3000
    );

    if (exists) {
      core.info(`✅ Account "${accountId}" already exists — skipping creation.`);
      const balance = await getAccountBalance(rpcUrl, accountId);
      core.info(`   Balance: ${balance} yoctoNEAR`);
      return { accountCreated: false, initialBalance: balance };
    }

    core.info(`Account "${accountId}" does not exist — creating via testnet helper…`);

    // NEAR testnet helper API: POST /account
    const publicKeyB58 = 'ed25519:' + base58Encode(publicKeyBytes);
    const helperUrl = 'https://helper.testnet.near.org';

    const response = await withRetry('helperCreateAccount', async () => {
      const res = await httpRequest(
        `${helperUrl}/account`,
        'POST',
        {
          newAccountId: accountId,
          newAccountPublicKey: publicKeyB58,
        },
        { 'Content-Type': 'application/json' },
        30000
      );

      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `Helper returned HTTP ${res.status}: ${res.body.slice(0, 300)}`
        );
      }
      return res;
    }, 3, 5000);

    core.info(`   Helper response: ${response.body.slice(0, 200)}`);

    // Wait for account to be visible on-chain
    core.info('   Waiting for account to appear on-chain (up to 60s)…');
    const deadline = Date.now() + 60000;
    let appeared = false;
    while (Date.now() < deadline) {
      await sleep(4000);
      appeared = await accountExists(rpcUrl, accountId);
      if (appeared) break;
      core.info('   …still waiting…');
    }
    if (!appeared) {
      throw new Error(`Account "${accountId}" did not appear on-chain within 60 seconds after creation.`);
    }

    const balance = await getAccountBalance(rpcUrl, accountId);
    core.info(`✅ Account "${accountId}" created! Balance: ${balance} yoctoNEAR`);
    return { accountCreated: true, initialBalance: balance };
  });
}

// ---------------------------------------------------------------------------
// STEP 2 — Request faucet funding
// ---------------------------------------------------------------------------
async function stepRequestFaucet(ctx, initialBalance) {
  return logGroup('Step 2 — Faucet Funding', async () => {
    const { accountId, requestFaucet, minBalanceYocto, rpcUrl } = ctx;

    const currentBalanceBig = BigInt(initialBalance || '0');
    core.info(`Current balance: ${currentBalanceBig} yoctoNEAR`);
    core.info(`Minimum required: ${minBalanceYocto} yoctoNEAR`);

    if (!requestFaucet) {
      core.info('ℹ️  Faucet funding disabled (request-faucet=false) — skipping.');
      return { faucetFunded: false, balanceAfterFaucet: initialBalance };
    }

    if (currentBalanceBig >= BigInt(minBalanceYocto)) {
      core.info('✅ Balance already sufficient — skipping faucet.');
      return { faucetFunded: false, balanceAfterFaucet: initialBalance };
    }

    core.info(`Balance below minimum — requesting faucet funding for "${accountId}"…`);

    // Primary: official testnet faucet
    const faucetEndpoints = [
      {
        url: 'https://helper.testnet.near.org/account/funds',
        body: { accountId },
      },
      {
        // Fallback: direct contract call through the helper
        url: `https://helper.testnet.near.org/faucet/send`,
        body: { account_id: accountId },
      },
    ];

    let funded = false;
    for (const endpoint of faucetEndpoints) {
      try {
        const res = await httpRequest(endpoint.url, 'POST', endpoint.body, {}, 30000);
        if (res.status === 200 || res.status === 201 || res.status === 204) {
          core.info(`   Faucet responded ${res.status}: ${res.body.slice(0, 200)}`);
          funded = true;
          break;
        }
        core.warning(`   Faucet endpoint ${endpoint.url} returned ${res.status} — trying next…`);
      } catch (err) {
        core.warning(`   Faucet endpoint ${endpoint.url} failed: ${err.message} — trying next…`);
      }
    }

    if (!funded) {
      core.warning('⚠️  All faucet endpoints failed — continuing with existing balance.');
      return { faucetFunded: false, balanceAfterFaucet: initialBalance };
    }

    // Wait for balance to update
    core.info('   Waiting for balance to update (up to 30s)…');
    let balanceAfterFaucet = initialBalance;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(4000);
      try {
        balanceAfterFaucet = await getAccountBalance(rpcUrl, accountId);
        if (BigInt(balanceAfterFaucet) > currentBalanceBig) {
          core.info(`   Balance updated: ${balanceAfterFaucet} yoctoNEAR`);
          break;
        }
      } catch { /* ignore transient */ }
    }

    core.info(`✅ Post-faucet balance: ${balanceAfterFaucet} yoctoNEAR`);
    return { faucetFunded: funded, balanceAfterFaucet };