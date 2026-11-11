// encodePlutusData writes Plutus Data as cbor2 writes it, the encoder of the Python builders this
// SDK ports: definite lengths throughout, an integer past a machine word as a tag 2 or 3 bignum,
// and a constructor under tags 121-127, 1280-1400 or 102. The expected bytes are cbor2's own.
// decodePlutusData, written for datums other protocols write, is the oracle the round trip is
// held to.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decodePlutusData, encodePlutusData } from '../plutus_data';
import type { PlutusData } from '../plutus_data';
import { bytesToHex } from '../cbor';
import { InputError } from '../errors';
import { readGenericData } from '../generic_data';

const WORD = 2n ** 64n;

function hex(data: PlutusData): string {
  return bytesToHex(encodePlutusData(data));
}

function constr(index: number, fields: PlutusData[] = []): PlutusData {
  return { constructor: index, fields };
}

/** Plutus Data of every shape, nested at most four deep. */
const plutusData: fc.Arbitrary<PlutusData> = fc.letrec<{ data: PlutusData }>((tie) => ({
  data: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.oneof(
      fc.bigInt({ min: -(2n ** 600n), max: 2n ** 600n }),
      fc.constantFrom(0n, 23n, 24n, 255n, 256n, WORD - 1n, WORD, -WORD, -WORD - 1n),
    ),
    fc.uint8Array({ maxLength: 80 }),
    fc.array(tie('data'), { maxLength: 4 }),
    fc
      .array(fc.tuple(tie('data'), tie('data')), { maxLength: 3 })
      .map((pairs): PlutusData => ({ map: pairs.map(([k, v]): [PlutusData, PlutusData] => [k, v]) })),
    fc
      .tuple(
        fc.oneof(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 7, max: 127 }), fc.integer({ min: 128, max: 2 ** 31 })),
        fc.array(tie('data'), { maxLength: 4 }),
      )
      .map(([index, fields]) => constr(index, fields)),
  ),
})).data;

describe('encodePlutusData', () => {
  it('writes each integer under its shortest head, and past a word as a bignum', () => {
    const cases: Array<[bigint, string]> = [
      [0n, '00'],
      [23n, '17'],
      [24n, '1818'],
      [255n, '18ff'],
      [256n, '190100'],
      [65535n, '19ffff'],
      [65536n, '1a00010000'],
      [2n ** 32n - 1n, '1affffffff'],
      [2n ** 32n, '1b0000000100000000'],
      [WORD - 1n, '1bffffffffffffffff'],
      [WORD, 'c249010000000000000000'],
      [-1n, '20'],
      [-24n, '37'],
      [-25n, '3818'],
      [-WORD, '3bffffffffffffffff'],
      [-WORD - 1n, 'c349010000000000000000'],
    ];
    for (const [n, expected] of cases) expect(hex(n), String(n)).toBe(expected);
    expect(hex(2n ** 520n - 1n)).toBe('c25841' + 'ff'.repeat(65));
  });

  it('writes a bytestring at any length as one definite string, as cbor2 does', () => {
    expect(hex(new Uint8Array())).toBe('40');
    expect(hex(new Uint8Array(64).fill(1))).toBe('5840' + '01'.repeat(64));
    expect(hex(new Uint8Array(65).fill(1))).toBe('5841' + '01'.repeat(65));
  });

  it('writes lists and maps definite, and constructors under their compact tags or tag 102', () => {
    expect(hex([1n, 2n])).toBe('820102');
    expect(hex({ map: [[1n, 2n]] })).toBe('a10102');
    expect(hex(constr(0))).toBe('d87980');
    expect(hex(constr(0, [1n]))).toBe('d8798101');
    expect(hex(constr(6))).toBe('d87f80');
    expect(hex(constr(7))).toBe('d9050080');
    expect(hex(constr(127))).toBe('d9057880');
    expect(hex(constr(128))).toBe('d86682188080');
    expect(hex(constr(2 ** 40, [new Uint8Array()]))).toBe('d866821b00000100000000008140');
  });

  it('refuses a constructor index no tag carries', () => {
    expect(() => encodePlutusData(constr(-1))).toThrow(InputError);
    expect(() => encodePlutusData(constr(1.5))).toThrow(InputError);
  });

  it('decodePlutusData reads back every value it writes, and writing that again gives the same bytes', () => {
    fc.assert(
      fc.property(plutusData, (data) => {
        const bytes = encodePlutusData(data);
        const back = decodePlutusData(bytes);
        expect(back).toEqual(data);
        expect(encodePlutusData(back)).toEqual(bytes);
      }),
      { numRuns: 500 },
    );
  });
});

function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('nothing was thrown');
}

describe('hex input to decodePlutusData and readGenericData', () => {
  // GenericData { 0: 1 }: an event feed reading alive, its value the last byte.
  const alive = 'd87981d87b81a10001';

  it('reads hex digits of either case', () => {
    expect(decodePlutusData('0A')).toBe(10n);
    expect(readGenericData(alive).value).toBe(1n);
    expect(readGenericData(alive.toUpperCase()).value).toBe(1n);
  });

  // parseInt(pair, 16) read each of these as a byte: 00, 00, 01, ff, 01, 01.
  it.each(['zz', '0g', '1g', '-1', ' 1', '+1'])('refuses the pair %j as no hex before reading any CBOR', (pair) => {
    for (const read of [decodePlutusData, readGenericData]) {
      const error = thrown(() => read(alive.slice(0, -2) + pair));
      expect(error).toBeInstanceOf(InputError);
      if (error instanceof InputError) {
        expect(error.code).toBe('INVALID_INPUT');
        expect(error.message).toBe('GenericData hex holds a character that is no hex digit');
      }
    }
  });
});
