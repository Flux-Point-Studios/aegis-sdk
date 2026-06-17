// floor_table.ts cell-regression locks — mirror contracts/lib/aegis/floor_table.ak
// CELL-FOR-CELL. The on-chain table is the authoritative backstop; if the Aiken
// table is recalibrated (a validator change), these pins MUST be updated in
// lockstep. Any silent drift fails here, not on-chain (which would DoS honest
// partner txs). Integer-only math throughout — premium*10000 >= coverage*floorBps.

import { describe, it, expect } from 'vitest';
import {
  MIN_STRIKE_DISTANCE_BPS,
  PRICE_SCALE,
  tBandIndex,
  barrierFloorBps,
  depegFloorBps,
  meetsBarrierFloor,
  meetsDepegFloor,
  depegStrikeInBand,
  barrierDBps,
  durationDays,
} from '../floor_table';

describe('t-band index (floors to lower edge {1,7,14,30,60,90,180})', () => {
  it('matches floor_table.ak t_band_index pins', () => {
    expect(tBandIndex(1)).toBe(0);
    expect(tBandIndex(6)).toBe(0);
    expect(tBandIndex(7)).toBe(1);
    expect(tBandIndex(13)).toBe(1);
    expect(tBandIndex(14)).toBe(2);
    expect(tBandIndex(29)).toBe(2);
    expect(tBandIndex(30)).toBe(3);
    expect(tBandIndex(59)).toBe(3);
    expect(tBandIndex(60)).toBe(4);
    expect(tBandIndex(89)).toBe(4);
    expect(tBandIndex(90)).toBe(5);
    expect(tBandIndex(179)).toBe(5);
    expect(tBandIndex(180)).toBe(6);
    expect(tBandIndex(365)).toBe(6);
  });
});

describe('barrier_floor_bps (GBM one-touch, σ=0.95/load+0.20) — cell pins', () => {
  it('d-band [1500,2000) corner 2000', () => {
    expect(barrierFloorBps(1500, 1)).toBe(0);
    expect(barrierFloorBps(1500, 7)).toBe(1203);
    expect(barrierFloorBps(1750, 14)).toBe(3083);
    expect(barrierFloorBps(1999, 30)).toBe(5512);
    expect(barrierFloorBps(1500, 60)).toBe(7494);
    expect(barrierFloorBps(1500, 90)).toBe(8463);
    expect(barrierFloorBps(1500, 365)).toBe(9776);
  });
  it('d-band [2000,2500) corner 2500', () => {
    expect(barrierFloorBps(2000, 7)).toBe(397);
    expect(barrierFloorBps(2000, 14)).toBe(1686);
    expect(barrierFloorBps(2499, 30)).toBe(4009);
    expect(barrierFloorBps(2000, 60)).toBe(6256);
    expect(barrierFloorBps(2000, 90)).toBe(7432);
    expect(barrierFloorBps(2000, 180)).toBe(9088);
  });
  it('d-band [2500,3000) corner 3000', () => {
    expect(barrierFloorBps(2500, 14)).toBe(789);
    expect(barrierFloorBps(2700, 30)).toBe(2714);
    expect(barrierFloorBps(2999, 60)).toBe(5036);
    expect(barrierFloorBps(2500, 90)).toBe(6370);
    expect(barrierFloorBps(2500, 180)).toBe(8346);
  });
  it('d-band [3000,4000) corner 4000', () => {
    expect(barrierFloorBps(3000, 30)).toBe(934);
    expect(barrierFloorBps(3500, 60)).toBe(2829);
    expect(barrierFloorBps(3999, 90)).toBe(4254);
    expect(barrierFloorBps(3000, 180)).toBe(6710);
  });
  it('d-band [4000,5000) corner 5000', () => {
    expect(barrierFloorBps(4000, 30)).toBe(184);
    expect(barrierFloorBps(4500, 60)).toBe(1204);
    expect(barrierFloorBps(4999, 90)).toBe(2362);
    expect(barrierFloorBps(4000, 180)).toBe(4921);
  });
  it('d-band [5000,7000) corner 7000', () => {
    expect(barrierFloorBps(5000, 60)).toBe(38);
    expect(barrierFloorBps(6000, 90)).toBe(229);
    expect(barrierFloorBps(6999, 180)).toBe(1497);
  });
  it('deep band [7000,∞) is all zero', () => {
    expect(barrierFloorBps(7000, 180)).toBe(0);
    expect(barrierFloorBps(9000, 365)).toBe(0);
  });
  it('below min strike distance (d<1500) fails closed at 1_000_000', () => {
    expect(barrierFloorBps(1499, 30)).toBe(1_000_000);
    expect(barrierFloorBps(0, 30)).toBe(1_000_000);
  });
  it('monotone non-increasing in d (deeper strike → lower-or-equal floor) at 30d', () => {
    const a = barrierFloorBps(1500, 30);
    const b = barrierFloorBps(2000, 30);
    const c = barrierFloorBps(2500, 30);
    const e = barrierFloorBps(3000, 30);
    const f = barrierFloorBps(4000, 30);
    expect(a >= b && b >= c && c >= e && e >= f).toBe(true);
  });
  it('monotone non-decreasing in T at d=20%', () => {
    expect(barrierFloorBps(2000, 7)).toBeLessThanOrEqual(barrierFloorBps(2000, 30));
    expect(barrierFloorBps(2000, 30)).toBeLessThanOrEqual(barrierFloorBps(2000, 90));
    expect(barrierFloorBps(2000, 90)).toBeLessThanOrEqual(barrierFloorBps(2000, 180));
  });
});

describe('depeg_floor_bps (Poisson hazard, λ=0.08/yr) — cell pins', () => {
  it('matches floor_table.ak depeg row', () => {
    expect(depegFloorBps(1)).toBe(2);
    expect(depegFloorBps(7)).toBe(18);
    expect(depegFloorBps(14)).toBe(36);
    expect(depegFloorBps(30)).toBe(78);
    expect(depegFloorBps(60)).toBe(156);
    expect(depegFloorBps(90)).toBe(234);
    expect(depegFloorBps(365)).toBe(464);
  });
});

describe('floor ≤ honest (never rejects an honest quote) — differential vs barrier_premium.py', () => {
  it('barrier floors sit at-or-below the honest σ=0.95 premium at sampled points', () => {
    expect(barrierFloorBps(2000, 30)).toBeLessThanOrEqual(5512); // honest d20/30d
    expect(barrierFloorBps(2700, 30)).toBeLessThanOrEqual(3463); // honest d27/30d
    expect(barrierFloorBps(1500, 90)).toBeLessThanOrEqual(9445); // honest d15/90d
  });
  it('depeg floor ≤ honest at 30d', () => {
    expect(depegFloorBps(30)).toBeLessThanOrEqual(79); // honest 78 bps (equal at corner ok)
  });
});

describe('floor predicates (integer cross-multiply, no division)', () => {
  it('meets_barrier_floor: fair premium passes, under-priced fails', () => {
    // 200 ADA cover, 30d, d=20% → floor 4009 bps = 80.18 ADA.
    expect(meetsBarrierFloor(96_000_000n, 200_000_000n, 2000, 30)).toBe(true);
    expect(meetsBarrierFloor(50_000_000n, 200_000_000n, 2000, 30)).toBe(false);
  });
  it('meets_barrier_floor: exact floor passes, one lovelace under fails', () => {
    expect(meetsBarrierFloor(80_180_000n, 200_000_000n, 2000, 30)).toBe(true);
    expect(meetsBarrierFloor(80_179_999n, 200_000_000n, 2000, 30)).toBe(false);
  });
  it('meets_barrier_floor: below min strike distance rejects any premium', () => {
    expect(meetsBarrierFloor(10_000_000_000n, 200_000_000n, 1000, 30)).toBe(false);
  });
  it('meets_depeg_floor: fair premium passes, under-priced fails', () => {
    expect(meetsDepegFloor(8_000_000n, 1_000_000_000n, 30)).toBe(true);
    expect(meetsDepegFloor(7_000_000n, 1_000_000_000n, 30)).toBe(false);
  });
});

describe('depeg strike band [50%,95%] of $1 peg', () => {
  it('accepts ≥5% below peg, rejects near-peg and absurd', () => {
    expect(depegStrikeInBand(950_000n)).toBe(true); // exactly 95% upper edge
    expect(depegStrikeInBand(900_000n)).toBe(true);
    expect(depegStrikeInBand(500_000n)).toBe(true); // 50% lower edge
    expect(depegStrikeInBand(990_000n)).toBe(false); // too shallow
    expect(depegStrikeInBand(400_000n)).toBe(false); // sub-50%
  });
});

describe('validator-mirrored derivations (integer, matches pool.ak:546/579)', () => {
  it('d_bps = (spot - strike) * 10000 / spot (integer floor)', () => {
    expect(barrierDBps(1_000_000n, 800_000n)).toBe(2000); // 20%
    expect(barrierDBps(1_000_000n, 850_000n)).toBe(1500); // 15% (min)
    expect(barrierDBps(1_000_000n, 1_000_000n)).toBe(0); // at-the-money
    expect(barrierDBps(1_000_000n, 999_900n)).toBe(1); // (100*10000)/1e6 = 1
    // strike above spot → negative distance (uninsurable; below the min floor)
    expect(barrierDBps(1_000_000n, 1_100_000n)).toBeLessThan(MIN_STRIKE_DISTANCE_BPS);
  });
  it('duration_days = (expiry - start) / 86_400_000 (integer floor)', () => {
    const day = 86_400_000n;
    expect(durationDays(0n, 30n * day)).toBe(30);
    expect(durationDays(0n, 30n * day - 1n)).toBe(29); // floors
    expect(durationDays(1_000_000n, 1_000_000n + 7n * day)).toBe(7);
  });
  it('PRICE_SCALE is 1e6', () => {
    expect(PRICE_SCALE).toBe(1_000_000n);
  });
});
