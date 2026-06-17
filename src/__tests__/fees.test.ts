// Fee/treasury math — real differential vs api/_treasury.py + api/policies.py.
//
// Every golden below was produced by running the LIVE Python helpers
// (policies.calculate_fee_total / calculate_net_pool_growth /
// calculate_protocol_fee_split and _treasury.calculate_treasury_cut) and
// frozen here. The validator reads the Conway treasury_donation body field and
// the pool/team/partner output values to the lovelace, so any drift between
// this TS mirror and the Python (which mirrors pricing.ak) is an on-chain
// reject. These pins catch it in CI.

import { describe, it, expect } from 'vitest';
import {
  calculateFeeTotal,
  calculateNetPoolGrowth,
  calculateProtocolFeeSplit,
  calculateTreasuryCut,
} from '../fees';

// [premium, feeBps, shareBps] -> {feeTotal, netGrowth, team, partner, treasury}
const GOLDEN = [
  { premium: 80_196_647n, feeBps: 200n, share: 0n, feeTotal: 2_000_000n, netGrowth: 78_196_647n, team: 2_000_000n, partner: 0n, treasury: 400_983n },
  { premium: 7_864_527n, feeBps: 200n, share: 0n, feeTotal: 2_000_000n, netGrowth: 5_864_527n, team: 2_000_000n, partner: 0n, treasury: 39_322n },
  { premium: 100_000_000n, feeBps: 200n, share: 0n, feeTotal: 2_000_000n, netGrowth: 98_000_000n, team: 2_000_000n, partner: 0n, treasury: 500_000n },
  // partner share set but cut is sub-MIN_UTXO → silently absorbed into team
  { premium: 100_000_000n, feeBps: 200n, share: 2_000n, feeTotal: 2_000_000n, netGrowth: 98_000_000n, team: 2_000_000n, partner: 0n, treasury: 500_000n },
  // partner cut survives (>= MIN_UTXO) → real partner output
  { premium: 2_000_000_000n, feeBps: 200n, share: 2_000n, feeTotal: 40_000_000n, netGrowth: 1_960_000_000n, team: 32_000_000n, partner: 8_000_000n, treasury: 10_000_000n },
  // non-default fee_bps (pool can carry 250)
  { premium: 60_227_593n, feeBps: 250n, share: 0n, feeTotal: 2_000_000n, netGrowth: 58_227_593n, team: 2_000_000n, partner: 0n, treasury: 376_422n },
  // degenerate: zero premium → no floor activation, all zero
  { premium: 0n, feeBps: 200n, share: 0n, feeTotal: 0n, netGrowth: 0n, team: 0n, partner: 0n, treasury: 0n },
] as const;

describe('fee + treasury math (bigint mirror of pricing.ak / _treasury.py)', () => {
  for (const g of GOLDEN) {
    it(`premium=${g.premium} feeBps=${g.feeBps} share=${g.share}`, () => {
      expect(calculateFeeTotal(g.premium, g.feeBps)).toBe(g.feeTotal);
      expect(calculateNetPoolGrowth(g.premium, g.feeBps)).toBe(g.netGrowth);
      const split = calculateProtocolFeeSplit(g.premium, g.feeBps, g.share);
      expect(split.teamCut).toBe(g.team);
      expect(split.partnerCut).toBe(g.partner);
      // invariant: team + partner == fee_total (always)
      expect(split.teamCut + split.partnerCut).toBe(g.feeTotal);
      // conservation: fee_total + net_growth == premium
      expect(g.feeTotal + g.netGrowth).toBe(g.premium);
      expect(calculateTreasuryCut(g.premium, g.feeBps)).toBe(g.treasury);
    });
  }

  it('two-stage treasury division floors at each step (not collapsed)', () => {
    // 80_196_647*200//10000 = 1_603_932 ; *2500//10000 = 400_983 (not 400_983.x)
    expect(calculateTreasuryCut(80_196_647n, 200n)).toBe(400_983n);
  });

  it('rejects negative inputs', () => {
    expect(() => calculateFeeTotal(-1n, 200n)).toThrow();
    expect(() => calculateProtocolFeeSplit(1n, -1n, 0n)).toThrow();
    expect(() => calculateTreasuryCut(1n, 200n, -1n)).toThrow();
  });
});
