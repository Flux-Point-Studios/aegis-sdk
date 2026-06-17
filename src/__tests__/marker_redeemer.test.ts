// MarkerRedeemer CBOR conformance vs api/policies.py truth source.
//
// Truth bytes captured via PyCardano `to_cbor_hex()` against the Aiken
// `MarkerRedeemer` definition in contracts/lib/aegis/types.ak (R17).
//
// Plutus Constr wire form:
//   * 0-field Constr  ->  d8 79+N <80>                     (definite empty array)
//   * N>=1 field Constr -> d8 79+N <9f> <fields...> <ff>   (indefinite array)
// Constr ids 0..6 fold into tags 121..127. Indefinite-length form on the
// fielded variants matches Aiken `cbor.serialise` output and PyCardano's
// PlutusData.to_cbor; the SDK MUST preserve this byte form (no canonical
// definite-length re-encoding), or a CIP-30 wallet round-trip will flip
// script_data_hash mid-flight (see reference_cip30_sign_submit.md).

import { describe, it, expect } from 'vitest';
import {
  encodeMarkerRedeemer,
  decodeMarkerRedeemer,
  bytesToHex,
  hexToBytes,
} from '../cbor';
import type { MarkerRedeemer } from '../types';

describe('MarkerRedeemer CBOR', () => {
  it('MintMarkers { count: 5 } -> d8799f05ff', () => {
    const r: MarkerRedeemer = { kind: 'MintMarkers', count: 5 };
    expect(bytesToHex(encodeMarkerRedeemer(r))).toBe('d8799f05ff');
  });

  it('BurnForClaim -> d87a80', () => {
    const r: MarkerRedeemer = { kind: 'BurnForClaim' };
    expect(bytesToHex(encodeMarkerRedeemer(r))).toBe('d87a80');
  });

  it('BurnForCancel -> d87b80', () => {
    const r: MarkerRedeemer = { kind: 'BurnForCancel' };
    expect(bytesToHex(encodeMarkerRedeemer(r))).toBe('d87b80');
  });

  it('BurnForExpire { count: 3 } -> d87c9f03ff', () => {
    const r: MarkerRedeemer = { kind: 'BurnForExpire', count: 3 };
    expect(bytesToHex(encodeMarkerRedeemer(r))).toBe('d87c9f03ff');
  });

  it('round-trips through decodeMarkerRedeemer (all 4 variants)', () => {
    const variants: MarkerRedeemer[] = [
      { kind: 'MintMarkers', count: 7 },
      { kind: 'BurnForClaim' },
      { kind: 'BurnForCancel' },
      { kind: 'BurnForExpire', count: 11 },
    ];
    for (const r of variants) {
      const enc = encodeMarkerRedeemer(r);
      const dec = decodeMarkerRedeemer(enc);
      expect(dec).toEqual(r);
      // Byte-form must be stable: encode-decode-encode produces identical bytes.
      expect(bytesToHex(encodeMarkerRedeemer(dec))).toBe(bytesToHex(enc));
    }
  });

  it('rejects non-positive count on MintMarkers', () => {
    expect(() =>
      encodeMarkerRedeemer({ kind: 'MintMarkers', count: 0 }),
    ).toThrow();
    expect(() =>
      encodeMarkerRedeemer({ kind: 'MintMarkers', count: -1 }),
    ).toThrow();
  });

  it('rejects non-positive count on BurnForExpire', () => {
    expect(() =>
      encodeMarkerRedeemer({ kind: 'BurnForExpire', count: 0 }),
    ).toThrow();
  });

  it('decodeMarkerRedeemer rejects an unknown constr tag', () => {
    // 0x80 = empty array; wrap in tag 128 (constr_id 7) which is not a
    // valid MarkerRedeemer variant.
    const bogus = hexToBytes('d81c80');
    expect(() => decodeMarkerRedeemer(bogus)).toThrow();
  });
});
