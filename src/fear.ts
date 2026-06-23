// T7 — AEGIS/FEAR index: read + classify Cardano's on-chain fear gauge.
//
// The FEAR index is a 0-100 score (a VIX analogue derived from Aegis insurance
// demand) computed API-side by api/fear_index.py::compute_fear_index, then
// PUBLISHED ON CHAIN as a Charli3-compatible GenericData datum
// (api/fear_index.py::build_fear_datum_cbor, publish_fear_index). Any Cardano
// protocol consumes it via a CIP-31 reference input — exactly like an Aegis /
// Charli3 price feed.
//
// The on-chain datum wire form (authoritative — fear_index.py:190-216) is:
//
//   Tag 121 ([ Tag 123 ([ { 0: fear_scaled, 1: created_ms, 2: expiry_ms } ]) ])
//   └ Constr 0 (OracleDatum)
//             └ Constr 2 (GenericData, "PriceData")
//                       └ Map<Int,Int>  0=value(scaled 1e6) 1=created 2=expiry
//
// This is byte-for-byte the same shape api/oracle.py::_extract_price_map reads
// back from chain for the ADA/USD price oracle, so `decodeFearDatum` is the
// read-side twin: hand it the raw inline-datum bytes from the fear-feed UTxO and
// it returns the typed fear reading. `classifyFear` then maps the 0-100 score to
// the qualitative band the UI + the API agree on.
//
// WHY a real decoder (not classify-only): the format is concretely on chain and
// decodable. The compute (the 7-signal weighting) stays API-side — re-deriving
// it here would risk divergence from the published datum — but the published
// BYTES are a fixed Plutus structure, so the SDK can read them with zero deps.

import { FEAR_SCALE } from './constants';
import { InputError } from './errors';

/** "price_scale" the fear value is multiplied by on chain (1e6, == FEAR_SCALE). */
export { FEAR_SCALE };

/** Qualitative fear band — matches FearPanel.tsx + fear_index.py labels. */
export type FearBand =
  | 'Extreme Calm'
  | 'Low Fear'
  | 'Moderate'
  | 'Elevated'
  | 'High Fear'
  | 'Extreme Fear';

/** A decoded on-chain fear reading (the inner GenericData map, typed). */
export interface FearReading {
  /** The 0-100 fear index (== fearScaled / FEAR_SCALE, integer-divided). */
  fearIndex: number;
  /** The raw on-chain value at map key 0 — the index scaled by FEAR_SCALE (1e6). */
  fearScaled: bigint;
  /** Datum creation time (POSIX ms) — map key 1. */
  createdMs: bigint;
  /** Datum expiry time (POSIX ms) — map key 2; after this the feed is stale. */
  expiryMs: bigint;
  /** The qualitative band for `fearIndex`. */
  band: FearBand;
}

// ---------------------------------------------------------------------------
// Minimal CBOR reader — only the slice the fear datum uses: tag, definite OR
// indefinite array, definite map (major 5), unsigned int. (The Aegis cbor.ts
// encoder/decoder is Constr-array-only; the fear datum carries a Map, so this
// module reads it directly rather than widening the shared codec.)
// ---------------------------------------------------------------------------

interface Reader {
  buf: Uint8Array;
  off: number;
}

function readByte(r: Reader): number {
  if (r.off >= r.buf.length) throw new InputError('INVALID_INPUT', 'fear datum: unexpected end of CBOR');
  return r.buf[r.off++];
}

/** Read a CBOR uint argument given the low-5-bits `info` of the head byte. */
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
  throw new InputError('INVALID_INPUT', `fear datum: unsupported CBOR int info=${info}`);
}

/** Read an unsigned integer (major 0). Fear map keys/values are all uints. */
function readUint(r: Reader): bigint {
  const b = readByte(r);
  if (b >> 5 !== 0) {
    throw new InputError('INVALID_INPUT', `fear datum: expected unsigned int, got head 0x${b.toString(16)}`);
  }
  return readUintArg(r, b & 0x1f);
}

/**
 * Enter a Plutus Constr at the reader and assert its constructor id, then enter
 * its body array (definite `81…` or indefinite `9f…ff`). Returns whether the
 * body array is indefinite (caller must consume the `ff` break when done).
 *
 * cbor2 (the publisher) emits DEFINITE arrays (`d879 81 …`); some chain readers
 * / wallets re-serialize to indefinite (`d879 9f … ff`). Accept both so a feed
 * round-tripped through a different encoder still decodes.
 */
function enterConstr(r: Reader, expectId: number): { indefinite: boolean } {
  const b1 = readByte(r);
  let tag: number;
  if (b1 === 0xd8) {
    tag = readByte(r);
  } else if (b1 === 0xd9) {
    tag = (readByte(r) << 8) | readByte(r);
  } else if (b1 >= 0xc0 && b1 <= 0xd7) {
    tag = b1 & 0x1f;
  } else {
    throw new InputError('INVALID_INPUT', `fear datum: expected Plutus tag, got 0x${b1.toString(16)}`);
  }
  const id = tag >= 121 && tag <= 127 ? tag - 121 : tag >= 1280 ? tag - 1280 + 7 : -1;
  if (id !== expectId) {
    throw new InputError('INVALID_INPUT', `fear datum: expected Constr ${expectId}, got tag ${tag}`);
  }
  const head = readByte(r);
  if (head === 0x9f) return { indefinite: true };
  if ((head >> 5) === 4) {
    // Definite array — we don't need the length (the structure is fixed), but
    // a single-element wrapper is all the fear datum uses.
    return { indefinite: false };
  }
  throw new InputError('INVALID_INPUT', `fear datum: expected array body, got 0x${head.toString(16)}`);
}

/** Read a definite-length map header (major 5) and return the entry count. */
function readMapHeader(r: Reader): number {
  const b = readByte(r);
  if ((b >> 5) !== 5) {
    throw new InputError('INVALID_INPUT', `fear datum: expected map, got head 0x${b.toString(16)}`);
  }
  const info = b & 0x1f;
  if (info === 31) {
    throw new InputError('INVALID_INPUT', 'fear datum: indefinite maps are not supported');
  }
  return Number(readUintArg(r, info));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode the raw inline-datum bytes of an on-chain FEAR-feed UTxO into a typed
 * reading. Mirrors the publisher's wire form (fear_index.py::build_fear_datum_cbor)
 * and the price-oracle read path (api/oracle.py::_extract_price_map):
 *
 *   Tag 121 ([ Tag 123 ([ Map{ 0: value, 1: created, 2: expiry } ]) ])
 *
 * Accepts a `Uint8Array` or a hex string. Map key 0 is the FEAR_SCALE-scaled
 * (1e6) index; `fearIndex` is the integer 0-100 score (value / FEAR_SCALE),
 * exactly as the publisher logs it (`fear_scaled // FEAR_SCALE`).
 *
 * @throws InputError if the bytes are not a well-formed fear datum.
 */
export function decodeFearDatum(raw: Uint8Array | string): FearReading {
  const buf =
    typeof raw === 'string'
      ? (() => {
          if (raw.length % 2 !== 0) throw new InputError('INVALID_INPUT', 'fear datum hex must have even length');
          const out = new Uint8Array(raw.length / 2);
          for (let i = 0; i < raw.length; i += 2) out[i / 2] = parseInt(raw.substring(i, i + 2), 16);
          return out;
        })()
      : raw;

  const r: Reader = { buf, off: 0 };
  // OracleDatum wrapper: Constr 0 [ GenericData ].
  const outer = enterConstr(r, 0);
  // GenericData (Charli3 "PriceData"): Constr 2 [ Map ].
  const inner = enterConstr(r, 2);

  const entries = readMapHeader(r);
  let value: bigint | undefined;
  let created: bigint | undefined;
  let expiry: bigint | undefined;
  for (let i = 0; i < entries; i++) {
    const key = readUint(r);
    const v = readUint(r);
    if (key === 0n) value = v;
    else if (key === 1n) created = v;
    else if (key === 2n) expiry = v;
    // Unknown keys are read-and-ignored (forward-compatible with extra fields).
  }
  if (inner.indefinite) {
    if (readByte(r) !== 0xff) throw new InputError('INVALID_INPUT', 'fear datum: missing GenericData array break');
  }
  if (outer.indefinite) {
    if (readByte(r) !== 0xff) throw new InputError('INVALID_INPUT', 'fear datum: missing OracleDatum array break');
  }

  if (value === undefined) {
    throw new InputError('INVALID_INPUT', 'fear datum: missing value at map key 0');
  }
  if (value < 0n) throw new InputError('INVALID_INPUT', 'fear datum: value must be non-negative');

  const fearIndex = Number(value / FEAR_SCALE);
  return {
    fearIndex,
    fearScaled: value,
    createdMs: created ?? 0n,
    expiryMs: expiry ?? 0n,
    band: classifyFear(fearIndex),
  };
}

/**
 * Map a 0-100 fear score to its qualitative band. The thresholds are the
 * canonical ones shared by api/fear_index.py (`<= 15 / <= 30 / <= 50 / <= 70 /
 * <= 85 / else`) and FearPanel.tsx (`< 16 / < 31 / < 51 / < 71 / < 86 / else`) —
 * the two expressions are identical on integer scores.
 *
 * @throws InputError if `score` is not a finite number in [0, 100].
 */
export function classifyFear(score: number): FearBand {
  if (!Number.isFinite(score)) throw new InputError('INVALID_INPUT', 'fear score must be a finite number');
  if (score < 0 || score > 100) throw new InputError('INVALID_INPUT', `fear score must be in [0, 100], got ${score}`);
  if (score < 16) return 'Extreme Calm';
  if (score < 31) return 'Low Fear';
  if (score < 51) return 'Moderate';
  if (score < 71) return 'Elevated';
  if (score < 86) return 'High Fear';
  return 'Extreme Fear';
}
