// Shared reader for the Charli3-compatible GenericData oracle datum.
//
// Several Aegis on-chain feeds publish the SAME fixed Plutus wire form — a
// Charli3 GenericData "PriceData" envelope:
//
//   Tag 121 ([ Tag 123 ([ { 0: value, 1: created_ms, 2: expiry_ms } ]) ])
//   └ Constr 0 (OracleDatum)
//             └ Constr 2 (GenericData, "PriceData")
//                       └ Map<Int,Int>  0=value  1=created_ms  2=expiry_ms
//
// This is byte-for-byte what api/oracle.py::_extract_price_map reads back for
// the ADA/USD price oracle, what api/fear_index.py::build_fear_datum_cbor emits
// for the FEAR gauge, AND what the EVENT_SLOT feeds publish for binary
// alive/liquidated events. The FEAR decoder (fear.ts) and the event-state
// decoder (event.ts) are both thin typed wrappers over `readGenericData` — the
// raw CBOR walk lives here ONCE so the two read paths cannot drift apart.
//
// The Aegis cbor.ts encoder/decoder is Constr-array-only; the GenericData datum
// carries a Map (major 5), so this module reads it directly rather than widening
// the shared codec. Zero runtime deps.

import { InputError } from './errors';

/** The inner GenericData map, typed. All three keys are CBOR unsigned ints. */
export interface GenericData {
  /** Map key 0 — the published value (FEAR: 1e6-scaled score; event: the
   *  binary alive/liquidated value; price: 1e6-scaled rate). */
  value: bigint;
  /** Map key 1 — datum creation time (POSIX ms). 0n if absent. */
  createdMs: bigint;
  /** Map key 2 — datum expiry time (POSIX ms); after this the feed is stale.
   *  0n if absent. */
  expiryMs: bigint;
}

interface Reader {
  buf: Uint8Array;
  off: number;
}

function readByte(r: Reader): number {
  if (r.off >= r.buf.length) throw new InputError('INVALID_INPUT', 'GenericData: unexpected end of CBOR');
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
  throw new InputError('INVALID_INPUT', `GenericData: unsupported CBOR int info=${info}`);
}

/** Read an unsigned integer (major 0). GenericData map keys/values are uints. */
function readUint(r: Reader): bigint {
  const b = readByte(r);
  if (b >> 5 !== 0) {
    throw new InputError('INVALID_INPUT', `GenericData: expected unsigned int, got head 0x${b.toString(16)}`);
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
    throw new InputError('INVALID_INPUT', `GenericData: expected Plutus tag, got 0x${b1.toString(16)}`);
  }
  const id = tag >= 121 && tag <= 127 ? tag - 121 : tag >= 1280 ? tag - 1280 + 7 : -1;
  if (id !== expectId) {
    throw new InputError('INVALID_INPUT', `GenericData: expected Constr ${expectId}, got tag ${tag}`);
  }
  const head = readByte(r);
  if (head === 0x9f) return { indefinite: true };
  if ((head >> 5) === 4) {
    // Definite array — we don't need the length (the structure is fixed), but
    // a single-element wrapper is all the GenericData datum uses.
    return { indefinite: false };
  }
  throw new InputError('INVALID_INPUT', `GenericData: expected array body, got 0x${head.toString(16)}`);
}

/** Read a definite-length map header (major 5) and return the entry count. */
function readMapHeader(r: Reader): number {
  const b = readByte(r);
  if ((b >> 5) !== 5) {
    throw new InputError('INVALID_INPUT', `GenericData: expected map, got head 0x${b.toString(16)}`);
  }
  const info = b & 0x1f;
  if (info === 31) {
    throw new InputError('INVALID_INPUT', 'GenericData: indefinite maps are not supported');
  }
  return Number(readUintArg(r, info));
}

/** Hex string → bytes, rejecting odd-length input. */
export function hexToBytesStrict(raw: string): Uint8Array {
  if (raw.length % 2 !== 0) throw new InputError('INVALID_INPUT', 'GenericData hex must have even length');
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) out[i / 2] = parseInt(raw.substring(i, i + 2), 16);
  return out;
}

/**
 * Decode the raw inline-datum bytes of a Charli3 GenericData oracle UTxO into
 * the typed inner map. Mirrors api/oracle.py::_extract_price_map and the
 * publisher's wire form (api/fear_index.py::build_fear_datum_cbor):
 *
 *   Tag 121 ([ Tag 123 ([ { 0: value, 1: created, 2: expiry } ]) ])
 *
 * Accepts a `Uint8Array` or a hex string. Unknown map keys are read-and-ignored
 * (forward-compatible with extra fields). `value` is required and must be
 * non-negative; `createdMs` / `expiryMs` default to 0n when absent.
 *
 * @throws InputError if the bytes are not a well-formed GenericData datum.
 */
export function readGenericData(raw: Uint8Array | string): GenericData {
  const buf = typeof raw === 'string' ? hexToBytesStrict(raw) : raw;

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
    if (readByte(r) !== 0xff) throw new InputError('INVALID_INPUT', 'GenericData: missing GenericData array break');
  }
  if (outer.indefinite) {
    if (readByte(r) !== 0xff) throw new InputError('INVALID_INPUT', 'GenericData: missing OracleDatum array break');
  }

  if (value === undefined) {
    throw new InputError('INVALID_INPUT', 'GenericData: missing value at map key 0');
  }
  if (value < 0n) throw new InputError('INVALID_INPUT', 'GenericData: value must be non-negative');

  return { value, createdMs: created ?? 0n, expiryMs: expiry ?? 0n };
}
