// The generic CBOR reader under the transaction codec: every form a transaction may be
// written in reads back to the bytes it came from, and what no transaction holds is refused.

import { describe, it, expect } from 'vitest';
import { cArray, cBytes, cInt, cMap, decodeCborItem, encodeCborItem } from '../cbor_item';
import { bytesToHex } from '../cbor';

const roundTrip = (hex: string) => bytesToHex(encodeCborItem(decodeCborItem(hex)));

describe('decodeCborItem', () => {
  it.each([
    ['indefinite array', '9f0102ff'],
    ['indefinite map', 'bf0102ff'],
    ['chunked bytes', '5f42010241 03ff'.replace(' ', '')],
    ['chunked text', '7f61616162ff'],
    ['tag 258 set', 'd9010282 0102'.replace(' ', '')],
    ['negative bignum head', '3b000000ffffffffff'],
    ['non-shortest head', '1800'],
    ['true, false, null', '83f5f4f6'],
  ])('writes a %s back as it was read', (_what, hex) => {
    expect(roundTrip(hex)).toBe(hex);
  });

  it('reads the values those forms spell', () => {
    const it = decodeCborItem('5f4201024103ff');
    expect(it.t === 'bytes' && bytesToHex(it.v)).toBe('010203');
    const neg = decodeCborItem('3b000000ffffffffff');
    expect(neg.t === 'int' && neg.v).toBe(-1n - 0xffffffffffn);
  });

  it('refuses what no transaction holds', () => {
    expect(() => decodeCborItem('f93c00')).toThrow(/floats/);
    expect(() => decodeCborItem('ff')).toThrow(/break outside/);
    expect(() => decodeCborItem('1f')).toThrow(/no indefinite length/);
    expect(() => decodeCborItem('1c')).toThrow(/reserved/);
    expect(() => decodeCborItem('5f4101 6161ff'.replace(' ', ''))).toThrow(/chunk of another type/);
    expect(() => decodeCborItem('81'.repeat(300) + '00')).toThrow(/nested past 256/);
    expect(() => decodeCborItem('0g')).toThrow(/not hex/);
    expect(() => decodeCborItem('8201')).toThrow(/end of CBOR/);
  });
});

describe('encodeCborItem', () => {
  it('writes the shortest head for each item built without bytes', () => {
    const built = cMap([[cInt(0), cArray([cInt(-1), cInt(24), cInt(65536), cBytes(new Uint8Array([7]))])]]);
    expect(bytesToHex(encodeCborItem(built))).toBe('a10084201818' + '1a00010000' + '4107');
  });
});
