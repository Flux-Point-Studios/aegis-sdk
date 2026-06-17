// Minimal zero-dependency BLAKE2b (RFC 7693) + the Aegis policy-id derivation.
//
// Used to derive a policy_id byte-identical to the canonical off-chain
// derivation api/policies.py::_generate_policy_id, so a composed policy is
// found under the same key by the Aegis claim indexer / /api/policies. The
// on-chain validator treats policy_id as opaque bytes and does NOT check it, so
// this is OFF-CHAIN interop only — but it makes the SDK's policies first-class
// in the indexer without the partner doing anything.
//
// BigInt 64-bit arithmetic: the policy-id preimage is ~80 bytes (a single
// 128-byte block), so clarity beats micro-perf here.

import { hexToBytes } from './cbor';

const MASK64 = (1n << 64n) - 1n;

const IV: bigint[] = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function compress(h: bigint[], block: bigint[], t: bigint, last: boolean): void {
  const v = h.slice(0, 8).concat(IV.slice(0, 8));
  v[12] ^= t & MASK64;
  v[13] ^= (t >> 64n) & MASK64;
  if (last) v[14] ^= MASK64;

  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
    g(0, 4, 8, 12, block[s[0]], block[s[1]]);
    g(1, 5, 9, 13, block[s[2]], block[s[3]]);
    g(2, 6, 10, 14, block[s[4]], block[s[5]]);
    g(3, 7, 11, 15, block[s[6]], block[s[7]]);
    g(0, 5, 10, 15, block[s[8]], block[s[9]]);
    g(1, 6, 11, 12, block[s[10]], block[s[11]]);
    g(2, 7, 8, 13, block[s[12]], block[s[13]]);
    g(3, 4, 9, 14, block[s[14]], block[s[15]]);
  }

  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b with a configurable digest length (bytes), no key. */
export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  const h = IV.slice(0, 8);
  h[0] ^= 0x01010000n ^ BigInt(outLen); // depth/fanout=1, keylen=0, digest=outLen

  // Pad input to a whole number of 128-byte blocks (at least one block).
  const blockCount = Math.max(1, Math.ceil(input.length / 128));
  const padded = new Uint8Array(blockCount * 128);
  padded.set(input);

  let t = 0n;
  for (let b = 0; b < blockCount; b++) {
    const isLast = b === blockCount - 1;
    t = isLast ? BigInt(input.length) : t + 128n;
    const words: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      // little-endian 64-bit word
      for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(padded[b * 128 + i * 8 + j]);
      words.push(w);
    }
    compress(h, words, t, isLast);
  }

  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = Number((h[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn);
  }
  return out;
}

/** BLAKE2b-224 (28-byte digest) — Cardano's `Blake2b_224`. */
export function blake2b224(input: Uint8Array): Uint8Array {
  return blake2b(input, 28);
}

function be(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function asBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? hexToBytes(v) : v;
}

/**
 * Derive the canonical Aegis policy_id, byte-identical to the off-chain
 * api/policies.py::_generate_policy_id (the claim indexer's key). Preimage:
 *   insured(28) ‖ strike(be8) ‖ coverage(be8) ‖ start(be8) ‖ expiry(be8)
 *   ‖ pool_nft(28) ‖ underwrite_tx_id(32) ‖ output_index(be2) [‖ batch_index(be2)]
 * then BLAKE2b-224. Pass `batchIndex` for the BatchUnderwrite flavour.
 */
export function derivePolicyId(p: {
  insuredPkh: string;
  strikePriceScaled: bigint;
  coverageLovelace: bigint;
  startTimeMs: bigint;
  expiryTimeMs: bigint;
  poolNft: Uint8Array | string;
  underwriteTxHash: string;
  underwriteOutputIndex: number;
  batchIndex?: number;
}): Uint8Array {
  const insured = asBytes(p.insuredPkh);
  if (insured.length !== 28) throw new Error('insuredPkh must be 28 bytes');
  const poolNft = asBytes(p.poolNft);
  if (poolNft.length !== 28) throw new Error('poolNft must be 28 bytes');
  const txid = hexToBytes(p.underwriteTxHash);
  if (txid.length !== 32) throw new Error('underwriteTxHash must be 32 bytes');

  const parts: Uint8Array[] = [
    insured,
    be(p.strikePriceScaled, 8),
    be(p.coverageLovelace, 8),
    be(p.startTimeMs, 8),
    be(p.expiryTimeMs, 8),
    poolNft,
    txid,
    be(BigInt(p.underwriteOutputIndex), 2),
  ];
  if (p.batchIndex !== undefined) parts.push(be(BigInt(p.batchIndex), 2));

  const total = parts.reduce((s, x) => s + x.length, 0);
  const preimage = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    preimage.set(part, off);
    off += part.length;
  }
  return blake2b224(preimage);
}
