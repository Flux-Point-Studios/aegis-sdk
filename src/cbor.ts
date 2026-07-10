// Minimal Plutus-Data CBOR encoder/decoder for the Aegis on-chain schema.
//
// Zero runtime dependencies. Implements only the slice of CBOR we need:
//   * unsigned/signed integer (major 0/1)
//   * byte string (major 2)             -- definite-length
//   * array (major 4)                   -- definite OR indefinite
//   * tag (major 6)
//
// Plutus Data Constr wire form:
//   Constr 0..6  -> CBOR tag 121..127
//   Constr 7+    -> CBOR tag 1280 + (id - 7)
//
// IMPORTANT: We emit indefinite-length arrays (start `9f` ... break `ff`)
// for any Constr that carries fields, matching PyCardano's `to_cbor_hex()`
// and Aiken's `cbor.serialise`. Definite-length is used only for the
// empty-fields case (`80`). Re-encoding from definite -> indefinite (or
// vice versa) would flip the bytes seen by a CIP-30 wallet, break
// `script_data_hash`, and silently invalidate every witness on the tx.

import type {
  AgentVaultDatum,
  AgentVaultRedeemerKind,
  LPTokenRedeemer,
  MarkerRedeemer,
  PlutusAddress,
  PlutusCredential,
  PlutusFullAddress,
  OracleProvider,
  PolicyDatum,
  PolicyRedeemer,
  PoolDatum,
  PoolRedeemer,
  RiskClass,
} from './types';

// ---------------------------------------------------------------------------
// Encoder primitives
// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Encode a CBOR unsigned-int "length/value" header for a given major type. */
function encodeHeader(major: number, value: bigint): Uint8Array {
  if (value < 0n) throw new Error('encodeHeader: negative value');
  if (value < 24n) return new Uint8Array([major | Number(value)]);
  if (value < 256n) return new Uint8Array([major | 24, Number(value)]);
  if (value < 65536n) {
    const v = Number(value);
    return new Uint8Array([major | 25, (v >> 8) & 0xff, v & 0xff]);
  }
  if (value < 4294967296n) {
    const v = Number(value);
    return new Uint8Array([
      major | 26,
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    ]);
  }
  const out = new Uint8Array(9);
  out[0] = major | 27;
  for (let i = 7; i >= 0; i--) {
    out[8 - i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

/** Encode an unsigned int (major 0). */
function encodeUint(value: bigint): Uint8Array {
  return encodeHeader(0x00, value);
}

/** Encode a signed int. Non-negative -> major 0; negative -> major 1 (encoding `-1 - n`). */
export function encodeInt(value: bigint): Uint8Array {
  if (value >= 0n) return encodeUint(value);
  return encodeHeader(0x20, -1n - value);
}

/** Encode a byte string (major 2, definite length). */
export function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concat([encodeHeader(0x40, BigInt(bytes.length)), bytes]);
}

/** Encode a CBOR tag wrapper. Tags 0..23 -> 1 byte, 24..255 -> 2 bytes, etc. */
function encodeTag(tag: number, content: Uint8Array): Uint8Array {
  let header: Uint8Array;
  if (tag < 24) {
    header = new Uint8Array([0xc0 | tag]);
  } else if (tag < 256) {
    header = new Uint8Array([0xd8, tag]);
  } else if (tag < 65536) {
    header = new Uint8Array([0xd9, (tag >> 8) & 0xff, tag & 0xff]);
  } else {
    throw new Error(`encodeTag: tag ${tag} too large`);
  }
  return concat([header, content]);
}

/** Encode a definite-length CBOR array. */
function encodeArrayDefinite(items: Uint8Array[]): Uint8Array {
  return concat([encodeHeader(0x80, BigInt(items.length)), ...items]);
}

/** Encode an indefinite-length CBOR array (`9f ... ff`). */
function encodeArrayIndefinite(items: Uint8Array[]): Uint8Array {
  return concat([new Uint8Array([0x9f]), ...items, new Uint8Array([0xff])]);
}

/**
 * Encode a Plutus Data Constr.
 *
 * Wire form:
 *   * 0 fields  -> `d8 (121+i) 80`               (definite empty array)
 *   * N fields  -> `d8 (121+i) 9f <fields> ff`   (indefinite array)
 *
 * This mirrors PyCardano's `PlutusData.to_cbor_hex()` and Aiken's
 * `cbor.serialise` byte-for-byte. The wallet CIP-30 round-trip is
 * sensitive to this exact byte form.
 */
export function encodeConstr(constrId: number, fields: Uint8Array[]): Uint8Array {
  const tag = constrId <= 6 ? 121 + constrId : 1280 + (constrId - 7);
  const body =
    fields.length === 0 ? encodeArrayDefinite([]) : encodeArrayIndefinite(fields);
  return encodeTag(tag, body);
}

// ---------------------------------------------------------------------------
// Decoder primitives
// ---------------------------------------------------------------------------

interface Reader {
  buf: Uint8Array;
  off: number;
}

function readByte(r: Reader): number {
  if (r.off >= r.buf.length) throw new Error('CBOR: unexpected EOF');
  return r.buf[r.off++];
}

function readBytes(r: Reader, n: number): Uint8Array {
  if (r.off + n > r.buf.length) throw new Error('CBOR: unexpected EOF');
  const out = r.buf.slice(r.off, r.off + n);
  r.off += n;
  return out;
}

function readUintArg(r: Reader, info: number): bigint {
  if (info < 24) return BigInt(info);
  if (info === 24) return BigInt(readByte(r));
  if (info === 25) return (BigInt(readByte(r)) << 8n) | BigInt(readByte(r));
  if (info === 26) {
    let v = 0n;
    for (let i = 0; i < 4; i++) v = (v << 8n) | BigInt(readByte(r));
    return v;
  }
  if (info === 27) {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(readByte(r));
    return v;
  }
  throw new Error(`CBOR: unsupported info=${info}`);
}

/** Decode a CBOR int (major 0 or 1). */
function decodeInt(r: Reader): bigint {
  const b = readByte(r);
  const major = b >> 5;
  const info = b & 0x1f;
  if (major === 0) return readUintArg(r, info);
  if (major === 1) return -1n - readUintArg(r, info);
  throw new Error(`CBOR: expected int, got major=${major}`);
}

/** Decode a CBOR byte string (major 2, definite length). */
function decodeBytes(r: Reader): Uint8Array {
  const b = readByte(r);
  if ((b >> 5) !== 2) throw new Error(`CBOR: expected bytes, got byte=0x${b.toString(16)}`);
  const len = Number(readUintArg(r, b & 0x1f));
  return readBytes(r, len);
}

/** Read array header. Returns either a fixed length, or -1 for indefinite. */
function readArrayHeader(r: Reader): number {
  const b = readByte(r);
  if ((b >> 5) !== 4) {
    throw new Error(`CBOR: expected array, got byte=0x${b.toString(16)}`);
  }
  const info = b & 0x1f;
  if (info === 31) return -1;
  return Number(readUintArg(r, info));
}

/** Decode the body of a Constr: an array (definite or indefinite). */
function decodeConstrBody<T>(r: Reader, decodeField: (r: Reader) => T): T[] {
  const len = readArrayHeader(r);
  const out: T[] = [];
  if (len === -1) {
    while (true) {
      if (r.buf[r.off] === 0xff) {
        r.off++;
        break;
      }
      out.push(decodeField(r));
    }
  } else {
    for (let i = 0; i < len; i++) out.push(decodeField(r));
  }
  return out;
}

/**
 * Peek a Constr at the current reader position. Returns the constructor
 * id and advances past the tag byte(s) so the caller can read the body.
 */
function readConstrTag(r: Reader): number {
  const b1 = readByte(r);
  let tag: number;
  if (b1 === 0xd8) {
    tag = readByte(r);
  } else if (b1 === 0xd9) {
    tag = (readByte(r) << 8) | readByte(r);
  } else if (b1 >= 0xc0 && b1 <= 0xd7) {
    tag = b1 & 0x1f;
  } else {
    throw new Error(`CBOR: expected tag, got byte=0x${b1.toString(16)}`);
  }
  if (tag >= 121 && tag <= 127) return tag - 121;
  if (tag >= 1280) return tag - 1280 + 7;
  throw new Error(`CBOR: tag ${tag} is not a Plutus Constr tag`);
}

// ---------------------------------------------------------------------------
// PolicyDatum encode
// ---------------------------------------------------------------------------

function encodeOracleProvider(p: OracleProvider): Uint8Array {
  const id = (
    { Charli3: 0, Orcfax: 1, AegisSelf: 2, Indigo: 3 } as const
  )[p];
  return encodeConstr(id, []);
}

/**
 * Encode an Address with VKH payment credential and optional VKH stake
 * credential. Mirrors Aiken's `Address` Plutus Data layout used in
 * api/policies.py (_PlutusAddress + _PlutusOptionStake).
 */
function encodePlutusAddress(addr: PlutusAddress): Uint8Array {
  if (addr.paymentVkh.length !== 28) {
    throw new Error(
      `partnerAddress.paymentVkh must be 28 bytes (got ${addr.paymentVkh.length}).`,
    );
  }
  // Payment credential: Constr 0 = VerificationKey { vkh } (Constr 1 would be Script).
  const paymentCred = encodeConstr(0, [encodeBytes(addr.paymentVkh)]);
  // Stake credential: Option<Inline VKH>. Inline wraps a Credential.
  let stake: Uint8Array;
  if (addr.stakeVkh === null) {
    stake = encodeConstr(1, []); // None
  } else {
    if (addr.stakeVkh.length !== 28) {
      throw new Error(
        `partnerAddress.stakeVkh must be 28 bytes (got ${addr.stakeVkh.length}).`,
      );
    }
    const stakeCred = encodeConstr(0, [encodeBytes(addr.stakeVkh)]);
    const inline = encodeConstr(0, [stakeCred]);
    stake = encodeConstr(0, [inline]); // Some(Inline(VKH))
  }
  return encodeConstr(0, [paymentCred, stake]);
}

function encodePartnerOption(addr: PlutusAddress | null): Uint8Array {
  if (addr === null) return encodeConstr(1, []); // None
  return encodeConstr(0, [encodePlutusAddress(addr)]); // Some(addr)
}

/**
 * Encode a Plutus credential. Mirrors Aiken's `Credential`:
 *   VerificationKey vkh -> Constr 0 [hash]
 *   Script          sh  -> Constr 1 [hash]
 */
function encodeCredential(c: PlutusCredential): Uint8Array {
  if (c.hash.length !== 28) {
    throw new Error(`credential hash must be 28 bytes (got ${c.hash.length}).`);
  }
  return encodeConstr(c.kind === 'script' ? 1 : 0, [encodeBytes(c.hash)]);
}

/**
 * Encode a full Plutus Data Address with arbitrary payment + optional inline
 * stake credentials (each a key or a script). Mirrors the on-chain Aiken
 * `Address` record and the api/policies.py `_PlutusAddress` shape, so a script
 * payment credential round-trips byte-for-byte.
 */
export function encodeFullAddress(addr: PlutusFullAddress): Uint8Array {
  const payment = encodeCredential(addr.payment);
  // Stake: Option<Referenced<Credential>>, Inline only.
  const stake =
    addr.stake === null
      ? encodeConstr(1, []) // None
      : encodeConstr(0, [encodeConstr(0, [encodeCredential(addr.stake)])]); // Some(Inline(cred))
  return encodeConstr(0, [payment, stake]);
}

/** Encode an `Option<Address>` over the full (script-capable) address shape. */
function encodeFullAddressOption(addr: PlutusFullAddress | null): Uint8Array {
  if (addr === null) return encodeConstr(1, []); // None
  return encodeConstr(0, [encodeFullAddress(addr)]); // Some(addr)
}

function encodeRiskClass(rc: RiskClass): Uint8Array {
  // Aiken RiskClass: Barrier=Constr0, Depeg=Constr1 (zero-field variants).
  return encodeConstr(rc === 'Barrier' ? 0 : 1, []);
}

/**
 * Encode a PolicyDatum to CBOR. Produces the 14-field positional form:
 *   Constr 0 [ bytes, bytes, int, int, int, int, int, bytes, bytes, bytes,
 *              OracleProvider, Option<Address>, int, RiskClass ]
 * The 14th field (risk_class) is mandatory — a 13-field datum is rejected by
 * the on-chain `expect pdat: PolicyDatum` decoder.
 *
 * If `payoutAddress` is set (an address, or explicit `null`), an Option<Address>
 * is appended as the 15th positional field. When `payoutAddress` is omitted the
 * 14-field form is produced unchanged, so callers targeting a validator without
 * the field are unaffected.
 */
export function encodePolicyDatum(d: PolicyDatum): Uint8Array {
  if (d.partnerAddress === null && d.partnerShareBps !== 0n) {
    throw new Error(
      'partnerAddress is null but partnerShareBps != 0 — set partnerShareBps=0n or supply a partner address.',
    );
  }
  const fields: Uint8Array[] = [
    encodeBytes(d.policyId),
    encodeBytes(d.insured),
    encodeInt(d.strikePrice),
    encodeInt(d.coverageAmount),
    encodeInt(d.premiumPaid),
    encodeInt(d.startTime),
    encodeInt(d.expiryTime),
    encodeBytes(d.oracleNft),
    encodeBytes(d.poolScriptHash),
    encodeBytes(d.poolNft),
    encodeOracleProvider(d.oracleProvider),
    encodePartnerOption(d.partnerAddress),
    encodeInt(d.partnerShareBps),
    encodeRiskClass(d.riskClass),
  ];
  // Optional extended fields. Aiken's record `expect` is STRICT on field count,
  // so a datum must carry EXACTLY the field count its target validator declares:
  //   - 14 fields (V4)            — neither payoutAddress nor receiptCommitment.
  //   - 15 fields (V5 payout)     — payoutAddress set, receiptCommitment omitted.
  //   - 16 fields (V5+P1 unified) — receiptCommitment set (the deployed V5+P1
  //     pool/policy validators decode this form). payout (field 15) is emitted
  //     too, defaulting to None when not supplied.
  if (d.receiptCommitment !== undefined) {
    fields.push(encodeFullAddressOption(d.payoutAddress ?? null));
    fields.push(
      d.receiptCommitment === null
        ? encodeConstr(1, []) // None -> Constr 1 [] (plain-Claim path)
        : encodeConstr(0, [encodeBytes(d.receiptCommitment)]), // Some(commitment)
    );
  } else if (d.payoutAddress !== undefined) {
    fields.push(encodeFullAddressOption(d.payoutAddress));
  }
  return encodeConstr(0, fields);
}

// ---------------------------------------------------------------------------
// PoolDatum encode
// ---------------------------------------------------------------------------

export function encodePoolDatum(d: PoolDatum): Uint8Array {
  return encodeConstr(0, [
    encodeInt(d.totalLiquidity),
    encodeInt(d.activeCoverage),
    encodeBytes(d.lpTokenPolicy),
    encodeInt(d.protocolFeeBps),
    encodeBytes(d.poolNft),
    encodeInt(d.lpSupply),
  ]);
}

/**
 * Decode an inline PoolDatum read from the live pool UTxO. A partner composing
 * an Underwrite reads the pool UTxO's datum bytes, decodes them with this, and
 * passes the typed PoolDatum to `buildUnderwriteParts`. Accepts both the
 * definite- and indefinite-length array forms.
 */
export function decodePoolDatum(bytes: Uint8Array): PoolDatum {
  const r: Reader = { buf: bytes, off: 0 };
  const id = readConstrTag(r);
  if (id !== 0) throw new Error(`PoolDatum expects Constr 0, got ${id}`);
  const len = readArrayHeader(r);
  const totalLiquidity = decodeInt(r);
  const activeCoverage = decodeInt(r);
  const lpTokenPolicy = decodeBytes(r);
  const protocolFeeBps = decodeInt(r);
  const poolNft = decodeBytes(r);
  const lpSupply = decodeInt(r);
  if (len === -1) {
    if (readByte(r) !== 0xff) throw new Error('PoolDatum: expected indefinite-array break');
  } else if (len !== 6) {
    throw new Error(`PoolDatum expects 6 fields, got ${len}`);
  }
  return { totalLiquidity, activeCoverage, lpTokenPolicy, protocolFeeBps, poolNft, lpSupply };
}

// ---------------------------------------------------------------------------
// AgentVaultDatum encode/decode (agent_vault.ak)
// ---------------------------------------------------------------------------

/** Encode an AgentVaultDatum as Constr 0 with 10 positional fields. */
export function encodeAgentVaultDatum(d: AgentVaultDatum): Uint8Array {
  return encodeConstr(0, [
    encodeBytes(d.owner),
    encodeBytes(d.agent),
    encodeInt(d.perTxCap),
    encodeInt(d.epochCap),
    encodeInt(d.epochLen),
    encodeInt(d.epochStart),
    encodeInt(d.epochSpent),
    encodeBytes(d.policyScript),
    encodeInt(d.maxFeeLeak),
    encodeBytes(d.observerScriptHash),
  ]);
}

/** Decode an inline AgentVaultDatum read from a live vault UTxO. */
export function decodeAgentVaultDatum(bytes: Uint8Array): AgentVaultDatum {
  const r: Reader = { buf: bytes, off: 0 };
  const id = readConstrTag(r);
  if (id !== 0) throw new Error(`AgentVaultDatum expects Constr 0, got ${id}`);
  const len = readArrayHeader(r);
  const owner = decodeBytes(r);
  const agent = decodeBytes(r);
  const perTxCap = decodeInt(r);
  const epochCap = decodeInt(r);
  const epochLen = decodeInt(r);
  const epochStart = decodeInt(r);
  const epochSpent = decodeInt(r);
  const policyScript = decodeBytes(r);
  const maxFeeLeak = decodeInt(r);
  const observerScriptHash = decodeBytes(r);
  if (len === -1) {
    if (readByte(r) !== 0xff) throw new Error('AgentVaultDatum: expected indefinite-array break');
  } else if (len !== 10) {
    throw new Error(`AgentVaultDatum expects 10 fields, got ${len}`);
  }
  return {
    owner,
    agent,
    perTxCap,
    epochCap,
    epochLen,
    epochStart,
    epochSpent,
    policyScript,
    maxFeeLeak,
    observerScriptHash,
  };
}

/** Encode an AgentVaultRedeemer: Spend=Constr 0, Sweep=Constr 1. */
export function encodeAgentVaultRedeemer(kind: AgentVaultRedeemerKind): Uint8Array {
  return encodeConstr(kind === 'Spend' ? 0 : 1, []);
}

// ---------------------------------------------------------------------------
// PolicyRedeemer encode/decode
// ---------------------------------------------------------------------------

const POLICY_REDEEMER_IDS: Record<PolicyRedeemer['kind'], number> = {
  Claim: 0,
  BatchClaim: 1,
  Expire: 2,
  BatchExpire: 3,
  Cancel: 4,
};

export function encodePolicyRedeemer(r: PolicyRedeemer): Uint8Array {
  return encodeConstr(POLICY_REDEEMER_IDS[r.kind], []);
}

export function decodePolicyRedeemer(bytes: Uint8Array): PolicyRedeemer {
  const r: Reader = { buf: bytes, off: 0 };
  const id = readConstrTag(r);
  decodeConstrBody(r, () => {
    throw new Error('PolicyRedeemer variants carry no fields');
  });
  switch (id) {
    case 0:
      return { kind: 'Claim' };
    case 1:
      return { kind: 'BatchClaim' };
    case 2:
      return { kind: 'Expire' };
    case 3:
      return { kind: 'BatchExpire' };
    case 4:
      return { kind: 'Cancel' };
    default:
      throw new Error(`Unknown PolicyRedeemer constr id ${id}`);
  }
}

// ---------------------------------------------------------------------------
// PoolRedeemer encode/decode
// ---------------------------------------------------------------------------

export function encodePoolRedeemer(r: PoolRedeemer): Uint8Array {
  switch (r.kind) {
    case 'Underwrite':
      return encodeConstr(0, [encodeInt(r.coverage), encodeInt(r.premium)]);
    case 'ProcessClaim':
      return encodeConstr(1, [encodeInt(r.payout)]);
    case 'AddLiquidity':
      return encodeConstr(2, [encodeInt(r.amount)]);
    case 'RemoveLiquidity':
      return encodeConstr(3, [encodeInt(r.amount)]);
    case 'BatchUnderwrite':
      return encodeConstr(4, [
        encodeInt(r.totalCoverage),
        encodeInt(r.totalPremium),
      ]);
    case 'BatchExpireProcess':
      return encodeConstr(5, [encodeInt(r.totalReturned)]);
    case 'AcceptCancellation':
      return encodeConstr(6, []);
  }
}

export function decodePoolRedeemer(bytes: Uint8Array): PoolRedeemer {
  const r: Reader = { buf: bytes, off: 0 };
  const id = readConstrTag(r);
  const fields = decodeConstrBody(r, decodeInt);
  switch (id) {
    case 0:
      if (fields.length !== 2) throw new Error('Underwrite expects 2 fields');
      return { kind: 'Underwrite', coverage: fields[0], premium: fields[1] };
    case 1:
      if (fields.length !== 1) throw new Error('ProcessClaim expects 1 field');
      return { kind: 'ProcessClaim', payout: fields[0] };
    case 2:
      if (fields.length !== 1) throw new Error('AddLiquidity expects 1 field');
      return { kind: 'AddLiquidity', amount: fields[0] };
    case 3:
      if (fields.length !== 1) throw new Error('RemoveLiquidity expects 1 field');
      return { kind: 'RemoveLiquidity', amount: fields[0] };
    case 4:
      if (fields.length !== 2) throw new Error('BatchUnderwrite expects 2 fields');
      return {
        kind: 'BatchUnderwrite',
        totalCoverage: fields[0],
        totalPremium: fields[1],
      };
    case 5:
      if (fields.length !== 1) throw new Error('BatchExpireProcess expects 1 field');
      return { kind: 'BatchExpireProcess', totalReturned: fields[0] };
    case 6:
      if (fields.length !== 0) throw new Error('AcceptCancellation expects 0 fields');
      return { kind: 'AcceptCancellation' };
    default:
      throw new Error(`Unknown PoolRedeemer constr id ${id}`);
  }
}

// ---------------------------------------------------------------------------
// LPTokenRedeemer encode/decode
// ---------------------------------------------------------------------------

export function encodeLPTokenRedeemer(r: LPTokenRedeemer): Uint8Array {
  return encodeConstr(r.kind === 'MintLP' ? 0 : 1, []);
}

export function decodeLPTokenRedeemer(bytes: Uint8Array): LPTokenRedeemer {
  const r: Reader = { buf: bytes, off: 0 };
  const id = readConstrTag(r);
  decodeConstrBody(r, () => {
    throw new Error('LPTokenRedeemer carries no fields');
  });
  if (id === 0) return { kind: 'MintLP' };
  if (id === 1) return { kind: 'BurnLP' };
  throw new Error(`Unknown LPTokenRedeemer constr id ${id}`);
}

// ---------------------------------------------------------------------------
// MarkerRedeemer encode/decode  (R16 marker token authority)
// ---------------------------------------------------------------------------

export function encodeMarkerRedeemer(r: MarkerRedeemer): Uint8Array {
  switch (r.kind) {
    case 'MintMarkers':
      if (r.count <= 0) {
        throw new Error('MintMarkers requires positive count');
      }
      return encodeConstr(0, [encodeInt(BigInt(r.count))]);
    case 'BurnForClaim':
      return encodeConstr(1, []);
    case 'BurnForCancel':
      return encodeConstr(2, []);
    case 'BurnForExpire':
      if (r.count <= 0) {
        throw new Error('BurnForExpire requires positive count');
      }
      return encodeConstr(3, [encodeInt(BigInt(r.count))]);
  }
}

export function decodeMarkerRedeemer(bytes: Uint8Array): MarkerRedeemer {
  const r: Reader = { buf: bytes, off: 0 };
  const id = readConstrTag(r);
  const fields = decodeConstrBody(r, decodeInt);
  switch (id) {
    case 0:
      if (fields.length !== 1) throw new Error('MintMarkers expects 1 field');
      return { kind: 'MintMarkers', count: Number(fields[0]) };
    case 1:
      if (fields.length !== 0) throw new Error('BurnForClaim expects 0 fields');
      return { kind: 'BurnForClaim' };
    case 2:
      if (fields.length !== 0) throw new Error('BurnForCancel expects 0 fields');
      return { kind: 'BurnForCancel' };
    case 3:
      if (fields.length !== 1) throw new Error('BurnForExpire expects 1 field');
      return { kind: 'BurnForExpire', count: Number(fields[0]) };
    default:
      throw new Error(`Unknown MarkerRedeemer constr id ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
