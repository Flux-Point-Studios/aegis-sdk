// Generic CBOR items: what a Cardano transaction is written in. The decoder reads every
// major type a transaction holds, definite or indefinite, keeps a text string as its UTF-8
// bytes, and records each item's byte span, so a reader can hash or copy the bytes an item
// was written in rather than a re-encoding of them. The encoder writes the shortest head for each length and integer, unless the
// item carries the raw bytes it was decoded from, which it writes unchanged.

import { concat, encodeHeader } from './cbor';
import { InputError } from './errors';

export type CborItem =
  | { t: 'int'; v: bigint; raw?: Uint8Array }
  | { t: 'bytes'; v: Uint8Array; raw?: Uint8Array }
  | { t: 'text'; utf8: Uint8Array; raw?: Uint8Array }
  | { t: 'array'; items: CborItem[]; indefinite?: boolean; raw?: Uint8Array }
  | { t: 'map'; entries: Array<[CborItem, CborItem]>; indefinite?: boolean; raw?: Uint8Array }
  | { t: 'tag'; tag: bigint; item: CborItem; raw?: Uint8Array }
  | { t: 'simple'; v: number; raw?: Uint8Array };

interface Reader {
  buf: Uint8Array;
  off: number;
}

const MAX_DEPTH = 256;

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', `CBOR: ${message}`);
}

function byte(r: Reader): number {
  if (r.off >= r.buf.length) refuse('unexpected end of CBOR');
  return r.buf[r.off++];
}

function head(r: Reader): { major: number; info: number; arg: bigint | null } {
  const b = byte(r);
  const major = b >> 5;
  const info = b & 0x1f;
  if (info < 24) return { major, info, arg: BigInt(info) };
  if (info === 31) {
    if (major === 0 || major === 1 || major === 6) refuse(`major type ${major} has no indefinite length`);
    return { major, info, arg: null };
  }
  if (info > 27) refuse(`reserved additional information ${info}`);
  let arg = 0n;
  for (let i = 0; i < 2 ** (info - 24); i++) arg = (arg << 8n) | BigInt(byte(r));
  return { major, info, arg };
}

function take(r: Reader, n: bigint): Uint8Array {
  if (BigInt(r.off) + n > BigInt(r.buf.length)) refuse('unexpected end of CBOR');
  const out = r.buf.slice(r.off, r.off + Number(n));
  r.off += Number(n);
  return out;
}

function atBreak(r: Reader): boolean {
  if (r.off >= r.buf.length) refuse('unexpected end of CBOR');
  if (r.buf[r.off] !== 0xff) return false;
  r.off++;
  return true;
}

function chunks(r: Reader, major: number): Uint8Array {
  const parts: Uint8Array[] = [];
  while (!atBreak(r)) {
    const h = head(r);
    if (h.major !== major || h.arg === null) refuse('an indefinite string holds a chunk of another type');
    parts.push(take(r, h.arg));
  }
  return concat(parts);
}

function item(r: Reader, depth: number): CborItem {
  if (depth > MAX_DEPTH) refuse(`nested past ${MAX_DEPTH} levels`);
  const start = r.off;
  const { major, info, arg } = head(r);
  let out: CborItem;
  switch (major) {
    case 0:
      out = { t: 'int', v: arg as bigint };
      break;
    case 1:
      out = { t: 'int', v: -1n - (arg as bigint) };
      break;
    case 2:
      out = { t: 'bytes', v: arg === null ? chunks(r, 2) : take(r, arg) };
      break;
    case 3:
      out = { t: 'text', utf8: arg === null ? chunks(r, 3) : take(r, arg) };
      break;
    case 4: {
      const items: CborItem[] = [];
      if (arg === null) while (!atBreak(r)) items.push(item(r, depth + 1));
      else for (let i = 0n; i < arg; i++) items.push(item(r, depth + 1));
      out = { t: 'array', items, indefinite: arg === null };
      break;
    }
    case 5: {
      const entries: Array<[CborItem, CborItem]> = [];
      if (arg === null) while (!atBreak(r)) entries.push([item(r, depth + 1), item(r, depth + 1)]);
      else for (let i = 0n; i < arg; i++) entries.push([item(r, depth + 1), item(r, depth + 1)]);
      out = { t: 'map', entries, indefinite: arg === null };
      break;
    }
    case 6:
      out = { t: 'tag', tag: arg as bigint, item: item(r, depth + 1) };
      break;
    default:
      if (info === 31) refuse('a break outside an indefinite item');
      if (info > 24) refuse('floats are no part of a transaction');
      out = { t: 'simple', v: Number(arg) };
  }
  out.raw = r.buf.subarray(start, r.off);
  return out;
}

/** Decode one CBOR item, hex or bytes, refusing trailing bytes. Every item keeps its raw bytes. */
export function decodeCborItem(raw: Uint8Array | string): CborItem {
  const buf = typeof raw === 'string' ? hexBytes(raw) : raw;
  const r: Reader = { buf, off: 0 };
  const out = item(r, 0);
  if (r.off !== buf.length) refuse(`${buf.length - r.off} trailing bytes`);
  return out;
}

function hexBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) refuse('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function lengthHead(major: number, n: number, indefinite: boolean | undefined): Uint8Array {
  return indefinite ? new Uint8Array([(major << 5) | 31]) : encodeHeader(major << 5, BigInt(n));
}

/** Write an item: its raw bytes when it carries them, else the shortest form of each head. */
export function encodeCborItem(it: CborItem): Uint8Array {
  if (it.raw !== undefined) return it.raw;
  switch (it.t) {
    case 'int':
      return it.v >= 0n ? encodeHeader(0x00, it.v) : encodeHeader(0x20, -1n - it.v);
    case 'bytes':
      return concat([encodeHeader(0x40, BigInt(it.v.length)), it.v]);
    case 'text':
      return concat([encodeHeader(0x60, BigInt(it.utf8.length)), it.utf8]);
    case 'array':
      return concat([
        lengthHead(4, it.items.length, it.indefinite),
        ...it.items.map(encodeCborItem),
        ...(it.indefinite ? [new Uint8Array([0xff])] : []),
      ]);
    case 'map':
      return concat([
        lengthHead(5, it.entries.length, it.indefinite),
        ...it.entries.flatMap(([k, v]) => [encodeCborItem(k), encodeCborItem(v)]),
        ...(it.indefinite ? [new Uint8Array([0xff])] : []),
      ]);
    case 'tag':
      return concat([encodeHeader(0xc0, it.tag), encodeCborItem(it.item)]);
    case 'simple':
      return encodeHeader(0xe0, BigInt(it.v));
  }
}

export function cInt(v: bigint | number): CborItem {
  return { t: 'int', v: BigInt(v) };
}

export function cBytes(v: Uint8Array): CborItem {
  return { t: 'bytes', v };
}

export function cArray(items: CborItem[]): CborItem {
  return { t: 'array', items };
}

export function cMap(entries: Array<[CborItem, CborItem]>): CborItem {
  return { t: 'map', entries };
}
