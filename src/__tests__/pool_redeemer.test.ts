// PoolRedeemer CBOR conformance vs api/policies.py truth source.
//
// R17 Aiken PoolRedeemer (contracts/lib/aegis/types.ak):
//   0 Underwrite { coverage, premium }
//   1 ProcessClaim { payout }                  -- NO policy_script field (R16-)
//   2 AddLiquidity { amount }
//   3 RemoveLiquidity { amount }
//   4 BatchUnderwrite { total_coverage, total_premium }
//   5 BatchExpireProcess { total_returned }    -- NO policy_script field (R16-)
//   6 AcceptCancellation                       -- NO fields at all (R17 EXT-21)
//
// Truth bytes via PyCardano `to_cbor_hex()`.

import { describe, it, expect } from 'vitest';
import {
  encodePoolRedeemer,
  decodePoolRedeemer,
  bytesToHex,
} from '../cbor';
import type { PoolRedeemer } from '../types';

describe('PoolRedeemer CBOR', () => {
  const cases: Array<[PoolRedeemer, string]> = [
    [
      { kind: 'Underwrite', coverage: 500_000_000n, premium: 10_000_000n },
      'd8799f1a1dcd65001a00989680ff',
    ],
    [
      { kind: 'ProcessClaim', payout: 100_000_000n },
      'd87a9f1a05f5e100ff',
    ],
    [
      { kind: 'AddLiquidity', amount: 50_000_000n },
      'd87b9f1a02faf080ff',
    ],
    [
      { kind: 'RemoveLiquidity', amount: 25_000_000n },
      'd87c9f1a017d7840ff',
    ],
    [
      {
        kind: 'BatchUnderwrite',
        totalCoverage: 1_000_000_000n,
        totalPremium: 20_000_000n,
      },
      'd87d9f1a3b9aca001a01312d00ff',
    ],
    [
      { kind: 'BatchExpireProcess', totalReturned: 500_000_000n },
      'd87e9f1a1dcd6500ff',
    ],
    [{ kind: 'AcceptCancellation' }, 'd87f80'],
  ];

  for (const [r, hex] of cases) {
    it(`${r.kind} -> ${hex}`, () => {
      expect(bytesToHex(encodePoolRedeemer(r))).toBe(hex);
    });
  }

  it('round-trips all variants', () => {
    for (const [r] of cases) {
      const enc = encodePoolRedeemer(r);
      const dec = decodePoolRedeemer(enc);
      expect(dec).toEqual(r);
    }
  });

  it('AcceptCancellation carries NO fields (R17 EXT-21 collateral pin)', () => {
    // A redeemer that adds any field to AcceptCancellation must not type-check.
    // We assert the wire form is the bare empty-constr; equivalent to a unit.
    const r: PoolRedeemer = { kind: 'AcceptCancellation' };
    const enc = bytesToHex(encodePoolRedeemer(r));
    expect(enc).toBe('d87f80');
    expect(enc.length).toBe(6); // 3 bytes hex-encoded
  });
});
