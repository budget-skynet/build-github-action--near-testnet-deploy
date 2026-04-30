async function jsonPost(urlStr, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    extraHeaders || {}
  );
  const res = await httpsRequest(urlStr, { method: 'POST', headers }, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} from ${urlStr}: ${res.body}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    return res.body;
  }
}

async function jsonGet(urlStr, extraHeaders) {
  const res = await httpsRequest(urlStr, { method: 'GET', headers: extraHeaders || {} });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} from ${urlStr}: ${res.body}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    return res.body;
  }
}

// ---------------------------------------------------------------------------
// NEAR RPC helpers
// ---------------------------------------------------------------------------

const NEAR_TESTNET_RPC = 'https://rpc.testnet.near.org';
const NEAR_TESTNET_HELPER = 'https://helper.testnet.near.org';
const NEAR_FAUCET_API = 'https://near-faucet.io/api/faucet/tokens';

async function nearRpcCall(method, params) {
  const payload = { jsonrpc: '2.0', id: 'dontcare', method, params };
  const result = await jsonPost(NEAR_TESTNET_RPC, payload);
  if (result.error) {
    throw new Error(`NEAR RPC error [${method}]: ${JSON.stringify(result.error)}`);
  }
  return result.result;
}

async function getAccountState(accountId) {
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return result;
  } catch (err) {
    if (err.message.includes('does not exist')) return null;
    if (err.message.includes('UNKNOWN_ACCOUNT')) return null;
    throw err;
  }
}

async function getAccessKeyInfo(accountId, publicKey) {
  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
    return result;
  } catch (err) {
    if (err.message.includes('does not exist')) return null;
    throw err;
  }
}

async function getLatestBlock() {
  return nearRpcCall('block', { finality: 'final' });
}

async function broadcastTx(signedTxBase64) {
  return nearRpcCall('broadcast_tx_commit', [signedTxBase64]);
}

async function queryContractCode(accountId) {
  try {
    return nearRpcCall('query', {
      request_type: 'view_code',
      finality: 'final',
      account_id: accountId,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Key / signing utilities (pure Node.js — no external crypto deps)
// ---------------------------------------------------------------------------

// NEAR uses ed25519. Node 15+ has webcrypto; for compatibility we use the
// built-in `crypto` module's `generateKeyPairSync` / `sign` where available,
// and fall back to a bundled minimal ed25519 implementation.

// Minimal ed25519 implementation based on the public-domain SUPERCOP ref10
// ported to JS. This avoids any runtime dependency on tweetnacl/noble.

/* eslint-disable no-bitwise */
const _ed25519 = (() => {
  // Field element: BigInt arithmetic mod p
  const P = 2n ** 255n - 19n;
  const Q = 2n ** 252n + 27742317777372353535851937790883648493n;

  function mod(a, b) { return ((a % b) + b) % b; }
  function modpow(base, exp, m) {
    let result = 1n;
    base = mod(base, m);
    while (exp > 0n) {
      if (exp & 1n) result = mod(result * base, m);
      exp >>= 1n;
      base = mod(base * base, m);
    }
    return result;
  }
  function inv(x) { return modpow(x, P - 2n, P); }

  const d = mod(-121665n * inv(121666n), P);
  const I = modpow(2n, (P - 1n) / 4n, P);

  function recoverX(y) {
    const y2 = mod(y * y, P);
    const x2 = mod((y2 - 1n) * inv(mod(d * y2 + 1n, P)), P);
    if (x2 === 0n) return 0n;
    let x = modpow(x2, (P + 3n) / 8n, P);
    if (mod(x * x - x2, P) !== 0n) x = mod(x * I, P);
    if (mod(x * x - x2, P) !== 0n) throw new Error('ed25519: bad point');
    if (x & 1n) x = P - x;
    return x;
  }

  const Gx = 15112221349535807912866137220509078750507884956996801825395754139930612250239n;
  const Gy = 46316835694926478169428394003475163141307993866256225615783033011972563516814n;
  const G = [Gx, Gy];

  function pointAdd(P1, P2) {
    const [x1, y1] = P1, [x2, y2] = P2;
    const dxy = mod(d * x1 * x2 * y1 * y2, P);
    const x3 = mod((x1 * y2 + x2 * y1) * inv(1n + dxy), P);
    const y3 = mod((y1 * y2 + x1 * x2) * inv(1n - dxy), P);
    return [x3, y3];
  }

  function scalarMult(s, point) {
    let result = null;
    let addend = point;
    while (s > 0n) {
      if (s & 1n) result = result ? pointAdd(result, addend) : addend;
      addend = pointAdd(addend, addend);
      s >>= 1n;
    }
    return result || [0n, 1n];
  }

  function encodePoint([x, y]) {
    const out = new Uint8Array(32);
    let yTmp = y;
    for (let i = 0; i < 32; i++) {
      out[i] = Number(yTmp & 0xFFn);
      yTmp >>= 8n;
    }
    if (x & 1n) out[31] |= 0x80;
    return out;
  }

  function decodeBigIntLE(bytes) {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
  }

  function sha512(data) {
    return crypto.createHash('sha512').update(data).digest();
  }

  function clamp(key) {
    key[0] &= 248;
    key[31] &= 127;
    key[31] |= 64;
    return key;
  }

  function publicKeyFromSeed(seed) {
    const h = sha512(seed);
    const a = clamp(h.slice(0, 32));
    const scalar = decodeBigIntLE(a);
    const point = scalarMult(scalar, G);
    return encodePoint(point);
  }

  function sign(message, secretKey) {
    // secretKey = 64 bytes: seed(32) + pubkey(32)  OR just 32-byte seed
    const seed = secretKey.length === 64 ? secretKey.slice(0, 32) : secretKey;
    const h = sha512(seed);
    const a = clamp(Buffer.from(h.slice(0, 32)));
    const prefix = h.slice(32);

    const pubKey = publicKeyFromSeed(seed);

    // r = SHA512(prefix || message) mod q
    const rHash = sha512(Buffer.concat([prefix, message]));
    const r = mod(decodeBigIntLE(rHash), Q);
    const R = scalarMult(r, G);
    const Renc = encodePoint(R);

    // S = (r + SHA512(R || pubkey || message) * a) mod q
    const kHash = sha512(Buffer.concat([Renc, pubKey, message]));
    const k = mod(decodeBigIntLE(kHash), Q);
    const aScalar = decodeBigIntLE(a);
    const S = mod(r + k * aScalar, Q);

    const Senc = new Uint8Array(32);
    let tmp = S;
    for (let i = 0; i < 32; i++) { Senc[i] = Number(tmp & 0xFFn); tmp >>= 8n; }

    return Buffer.concat([Renc, Senc]);
  }

  return { publicKeyFromSeed, sign };
})();
/* eslint-enable no-bitwise */

// ---------------------------------------------------------------------------
// NEAR key parsing
// ---------------------------------------------------------------------------

function parsePrivateKey(rawKey) {
  // Accepts:
  //   "ed25519:<base58 seed>"
  //   raw base58 64-byte keypair
  //   hex 64-byte keypair
  let keyStr = rawKey.trim();
  let seedBytes;

  if (keyStr.startsWith('ed25519:')) {
    keyStr = keyStr.slice('ed25519:'.length);
  }

  // Try hex first (64 bytes = 128 hex chars, or 32 bytes = 64 hex chars)
  if (/^[0-9a-fA-F]+$/.test(keyStr)) {
    const buf = Buffer.from(keyStr, 'hex');
    seedBytes = buf.length >= 64 ? buf.slice(0, 32) : buf;
  } else {
    // Assume base58
    seedBytes = base58Decode(keyStr);
    if (seedBytes.length === 64) seedBytes = seedBytes.slice(0, 32);
  }

  if (seedBytes.length !== 32) {
    throw new Error(`Private key seed must be 32 bytes, got ${seedBytes.length}`);
  }

  const publicKeyBytes = _ed25519.publicKeyFromSeed(seedBytes);
  const publicKeyBase58 = base58Encode(publicKeyBytes);

  return {
    seedBytes,
    publicKeyBytes: Buffer.from(publicKeyBytes),
    publicKeyBase58,
    publicKey: `ed25519:${publicKeyBase58}`,
  };
}

// ---------------------------------------------------------------------------
// Base58 utilities (Bitcoin alphabet — same as NEAR)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex') || '00');
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(2, '0');
  const padded = hex.length % 2 ? '0' + hex : hex;
  const bytes = Buffer.from(padded, 'hex');
  const leadingZeros = [...str].filter(c => c === '1').length;
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

// ---------------------------------------------------------------------------
// NEAR transaction serialization (Borsh subset)
// ---------------------------------------------------------------------------

// Borsh encoding helpers
class BorshWriter {
  constructor() { this._buf = []; }

  writeU8(v) { this._buf.push(v & 0xFF); }

  writeU32(v) {
    this._buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF);
  }

  writeU64(v) {
    // v is BigInt
    const lo = Number(v & 0xFFFFFFFFn);
    const hi = Number((v >> 32n) & 0xFFFFFFFFn);
    this.writeU32(lo);
    this.writeU32(hi);
  }

  writeU128(v) {
    this.writeU64(v & 0xFFFFFFFFFFFFFFFFn);
    this.writeU64((v >> 64n) & 0xFFFFFFFFFFFFFFFFn);
  }

  writeBytes(buf) {
    for (const b of buf) this._buf.push(b);
  }

  writeString(str) {
    const bytes = Buffer.from(str, 'utf8');
    this.writeU32(bytes.length);
    this.writeBytes(bytes);
  }

  writeByteArray(buf) {
    this.writeU32(buf.length);
    this.writeBytes(buf);
  }

  toBuffer() { return Buffer.from(this._buf); }
}

// Action types
const ACTION_DEPLOY_CONTRACT = 7;
const ACTION_FUNCTION_CALL = 2;

function serializeDeployContractTx(params) {
  // params: { signerId, signerPublicKeyBytes, nonce, receiverId, blockHash, wasmBytes }
  const w = new BorshWriter();

  // signer_id
  w.writeString(params.signerId);

  // public key: 0 = ed25519, then 32 bytes
  w.writeU8(0);
  w.writeBytes(params.signerPublicKeyBytes);

  // nonce (u64)
  w.writeU64(BigInt(params.nonce));

  // receiver_id
  w.writeString(params.receiverId);

  // block_hash (32 bytes)
  w.writeBytes(params.blockHash);

  // actions length (u32)
  w.writeU32(1);

  // action enum: 7 = DeployContract
  w.writeU8(ACTION_DEPLOY_CONTRACT);

  // DeployContract: code (byte array)
  w.writeByteArray(params.wasmBytes);

  return w.toBuffer();
}

function serializeFunctionCallTx(params) {
  // params: { signerId, signerPublicKeyBytes, nonce, receiverId, blockHash,
  //           methodName, args (Buffer), gas (BigInt), deposit (BigInt) }
  const w = new BorshWriter();

  w.writeString(params.signerId);
  w.writeU8(0);
  w.writeBytes(params.signerPublicKeyBytes);
  w.writeU64(BigInt(params.nonce));
  w.writeString(params.receiverId);
  w.writeBytes(params.blockHash);

  w.writeU32(1);
  w.writeU8(ACTION_FUNCTION_CALL);

  w.writeString(params.methodName);
  w.writeByteArray(params.args);
  w.writeU64(params.gas);
  w.writeU128(params.deposit);

  return w.toBuffer();
}

async function signAndBroadcast(txBuffer, seedBytes) {
  const hash = crypto.createHash('sha256').update(txBuffer).digest();
  const signature = _ed25519.sign(hash, seedBytes);

  // Wrap in SignedTransaction
  const w = new BorshWriter();
  w.writeBytes(txBuffer);  // transaction bytes
  // signature: 0 = ed25519, then 64 bytes
  w.writeU8(0);
  w.writeBytes(signature);

  const signedBuffer = w.toBuffer();
  const base64 = signedBuffer.toString('base64');
  return broadcastTx(base64);
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function retry(fn, attempts, delayMs, label) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      core.warning(`${label} attempt ${i + 1}/${attempts} failed: ${err.message}`);
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Step 1: Auto-create testnet account if needed
// ---------------------------------------------------------------------------

async function stepCreateAccountIfNeeded(accountId, keyPair) {
  core.startGroup('Step 1: Verify / create testnet account');
  let accountExists = false;

  try {
    const state = await getAccountState(accountId);
    if (state && state.amount !== undefined) {
      core.info(`Account ${accountId} already exists. Balance: ${formatNEAR(state.amount)} NEAR`);
      accountExists = true;
    }
  } catch (err) {
    core.info(`Could not query account state: ${err.message}. Will attempt creation.`);
  }

  if (!accountExists) {
    core.info(`Account ${accountId} does not exist. Attempting creation via testnet helper...`);

    // NEAR testnet helper: POST /account
    const payload = {
      newAccountId: accountId,
      newAccountPublicKey: keyPair.publicKey,
    };

    try {
      const result = await retry(
        () => jsonPost(`${NEAR_TESTNET_HELPER}/account`, payload),
        3,
        2000,
        'Account creation'
      );
      core.info(`Account creation response: ${JSON.stringify(result)}`);
    } catch (err) {
      // Helper may reject if account exists or different key; check again
      core.warning(`Helper account creation returned: ${err.message}`);
    }

    // Confirm
    await sleep(3000);
    const state = await getAccountState(accountId);
    if (state && state.amount !== undefined) {
      core.info(`Account ${accountId} successfully created. Balance: ${formatNEAR(state.amount)} NEAR`);
      accountExists = true;
    } else {
      throw new Error(
        `Account ${accountId} could not be created or verified. ` +
        'Ensure the account name is valid (lowercase, ends with .testnet) and the public key is correct.'
      );
    }
  }

  core.endGroup();
  return { accountExists };
}

// ---------------------------------------------------------------------------
// Step 2: Request faucet funding
// ---------------------------------------------------------------------------

async function stepFundAccount(accountId, fundingAmountNEAR) {
  core.startGroup('Step 2: Request faucet funding');

  const amountFloat = parseFloat(fundingAmountNEAR);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    core.info('Faucet funding amount is 0 or invalid — skipping.');
    core.endGroup();
    return { funded: false, amount: '0' };
  }

  core.info(`Requesting ${amountFloat} NEAR from testnet faucet for account ${accountId}...`);

  // Try NEAR faucet API
  let funded = false;
  let txHash = null;

  try {
    const payload = { account_id: accountId };
    const result = await retry(
      () => jsonPost(NEAR_FAUCET_API, payload, { 'User-Agent': 'near-testnet-deploy-action/1.0' }),
      3,
      4000,
      'Faucet request'
    );
    core.info(`Faucet response: ${JSON.stringify(result)}`);
    funded = true;
    txHash = result.txHash || result.transaction_hash || null;
  } catch (err) {
    core.warning(`Primary faucet failed: ${err.message}. Trying testnet helper faucet...`);
    // Fallback: NEAR testnet helper send-money endpoint
    try {
      const helperPayload = { account_id: accountId };
      const res = await jsonPost(`${NEAR_TESTNET_HELPER}/faucet`, helperPayload);
      core.info(`Helper faucet response: ${JSON.stringify(res)}`);
      funded = true;
    } catch (err2) {
      core.warning(`Helper faucet also failed: ${err2.message}. Proceeding — account may already have sufficient balance.`