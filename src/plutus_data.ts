// A Plutus Data decoder for datums another protocol writes: every form the ledger's
// Data holds, whichever lengths the writer chose. Integers (major 0 and 1, and the
// tag 2 and 3 bignums), bytestrings (definite, or the chunked indefinite form
// serialiseData writes past 64 bytes), lists and maps (definite or indefinite), and
// constructors under tags 121-127, 1280-1400 and 102. Anything else is refused.
//
// The encoder writes one form of each, the definite form the cbor2 Python library writes,
// so a builder ported from Python writes its bytes exactly.

import { blake2b224 } from './blake2b';
import { bytesToHex, concat, encodeBytes, encodeConstr, encodeHeader, encodeInt } from './cbor';
import { InputError } from './errors';
import { hexToBytesStrict } from './generic_data';

export interface PlutusConstr {
  constructor: number;
  fields: PlutusData[];
}

export interface PlutusMap {
  map: Array<[PlutusData, PlutusData]>;
}

export type PlutusData = bigint | Uint8Array | PlutusData[] | PlutusMap | PlutusConstr;

interface Reader {
  buf: Uint8Array;
  off: number;
}

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', `Plutus data: ${message}`);
}

function byte(r: Reader): number {
  if (r.off >= r.buf.length) refuse('unexpected end of CBOR');
  return r.buf[r.off++];
}

/** The head at the reader: its major type and argument, null for an indefinite length. */
function head(r: Reader): { major: number; arg: bigint | null } {
  const b = byte(r);
  const info = b & 0x1f;
  if (info < 24) return { major: b >> 5, arg: BigInt(info) };
  if (info === 31) return { major: b >> 5, arg: null };
  if (info > 27) refuse(`reserved additional information ${info}`);
  let arg = 0n;
  for (let i = 0; i < 2 ** (info - 24); i++) arg = (arg << 8n) | BigInt(byte(r));
  return { major: b >> 5, arg };
}

function take(r: Reader, n: bigint): Uint8Array {
  if (BigInt(r.off) + n > BigInt(r.buf.length)) refuse('unexpected end of CBOR');
  const out = r.buf.slice(r.off, r.off + Number(n));
  r.off += Number(n);
  return out;
}

function atBreak(r: Reader): boolean {
  if (r.buf[r.off] !== 0xff) return false;
  r.off++;
  return true;
}

function bytesOf(r: Reader, arg: bigint | null): Uint8Array {
  if (arg !== null) return take(r, arg);
  const chunks: Uint8Array[] = [];
  while (!atBreak(r)) {
    const chunk = head(r);
    if (chunk.major !== 2 || chunk.arg === null) refuse('an indefinite bytestring holds a chunk that is no definite bytestring');
    chunks.push(take(r, chunk.arg));
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function items<T>(r: Reader, arg: bigint | null, item: () => T): T[] {
  const out: T[] = [];
  if (arg === null) {
    while (!atBreak(r)) out.push(item());
  } else {
    for (let i = 0n; i < arg; i++) out.push(item());
  }
  return out;
}

function bignum(bytes: Uint8Array): bigint {
  return bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}

function data(r: Reader): PlutusData {
  const { major, arg } = head(r);
  switch (major) {
    case 0:
      if (arg === null) refuse('an integer of indefinite length');
      return arg;
    case 1:
      if (arg === null) refuse('an integer of indefinite length');
      return -1n - arg;
    case 2:
      return bytesOf(r, arg);
    case 4:
      return items(r, arg, () => data(r));
    case 5:
      return { map: items(r, arg, () => [data(r), data(r)] as [PlutusData, PlutusData]) };
    case 6: {
      if (arg === 2n || arg === 3n) {
        const inner = head(r);
        if (inner.major !== 2) refuse('a bignum tag holds no bytestring');
        const n = bignum(bytesOf(r, inner.arg));
        return arg === 2n ? n : -1n - n;
      }
      if (arg !== null && arg >= 121n && arg <= 127n) return constr(r, Number(arg) - 121);
      if (arg !== null && arg >= 1280n && arg <= 1400n) return constr(r, Number(arg) - 1280 + 7);
      if (arg === 102n) {
        const pair = data(r);
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'bigint' || !Array.isArray(pair[1])) {
          refuse('a general constructor is [index, fields]');
        }
        return { constructor: Number(pair[0]), fields: pair[1] as PlutusData[] };
      }
      return refuse(`CBOR tag ${arg} is no Plutus data`);
    }
    default:
      return refuse(`CBOR major type ${major} is no Plutus data`);
  }
}

function constr(r: Reader, index: number): PlutusConstr {
  const fields = data(r);
  if (!Array.isArray(fields)) refuse(`constructor ${index} carries no field list`);
  return { constructor: index, fields };
}

/** Decode one Plutus Data item, hex or bytes, refusing trailing bytes. */
export function decodePlutusData(raw: Uint8Array | string): PlutusData {
  const buf = typeof raw === 'string' ? hexToBytesStrict(raw) : raw;
  const r: Reader = { buf, off: 0 };
  const out = data(r);
  if (r.off !== buf.length) refuse(`${buf.length - r.off} trailing bytes`);
  return out;
}

const WORD = 1n << 64n;

/** A non-negative integer's minimal big-endian bytes: a bignum's content. */
function magnitude(n: bigint): Uint8Array {
  const out: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) out.unshift(Number(v & 0xffn));
  return new Uint8Array(out);
}

function integer(n: bigint): Uint8Array {
  if (n >= WORD) return concat([encodeHeader(0xc0, 2n), encodeBytes(magnitude(n))]);
  if (n < -WORD) return concat([encodeHeader(0xc0, 3n), encodeBytes(magnitude(-1n - n))]);
  return encodeInt(n);
}

function list(items: PlutusData[]): Uint8Array {
  return concat([encodeHeader(0x80, BigInt(items.length)), ...items.map(encodePlutusData)]);
}

function constrTag(index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) refuse(`constructor index ${index} has no tag`);
  if (index < 7) return encodeHeader(0xc0, BigInt(121 + index));
  if (index < 128) return encodeHeader(0xc0, BigInt(1280 + index - 7));
  return concat([encodeHeader(0xc0, 102n), encodeHeader(0x80, 2n), integer(BigInt(index))]);
}

/**
 * Write Plutus Data as cbor2 writes it: every list, map and bytestring definite, an integer
 * past a machine word as a tag 2 or 3 bignum, and a constructor under tags 121-127, then
 * 1280-1400, then tag 102. A bytestring past 64 bytes stays one string, which the ledger
 * refuses in a datum; no field these builders write reaches that length.
 */
export function encodePlutusData(data: PlutusData): Uint8Array {
  if (typeof data === 'bigint') return integer(data);
  if (data instanceof Uint8Array) return encodeBytes(data);
  if (Array.isArray(data)) return list(data);
  if ('map' in data) {
    return concat([
      encodeHeader(0xa0, BigInt(data.map.length)),
      ...data.map.flatMap(([k, v]) => [encodePlutusData(k), encodePlutusData(v)]),
    ]);
  }
  return concat([constrTag(data.constructor), list(data.fields)]);
}

// --- reading decoded data -------------------------------------------------------------
// Their refusals name the field alone: vector suites replay them byte for byte.

function refuseField(message: string): never {
  throw new InputError('INVALID_INPUT', message);
}

export function constrOf(node: PlutusData, what: string): PlutusConstr {
  if (typeof node !== 'object' || node instanceof Uint8Array || Array.isArray(node) || !('fields' in node)) {
    refuseField(`${what} is no constructor`);
  }
  return node;
}

export function fieldsOf(node: PlutusData, what: string, arity: number): PlutusData[] {
  const c = constrOf(node, what);
  if (c.constructor !== 0) refuseField(`${what} is constructor ${c.constructor}, not 0`);
  if (c.fields.length !== arity) refuseField(`${what} takes ${arity} fields, got ${c.fields.length}`);
  return c.fields;
}

export function dataInt(node: PlutusData, what: string): bigint {
  if (typeof node !== 'bigint') refuseField(`${what} is no integer`);
  return node;
}

export function dataHex(node: PlutusData, what: string): string {
  if (!(node instanceof Uint8Array)) refuseField(`${what} is no bytestring`);
  return bytesToHex(node);
}

/**
 * blake2b-224 of an output reference as serialiseData writes it: the name a FluidTokens loan
 * and a gen-3 position each take from the input that creates them.
 */
export function outRefDigest(txId: Uint8Array, index: bigint): string {
  return bytesToHex(blake2b224(encodeConstr(0, [encodePlutusData(txId), encodePlutusData(index)])));
}
