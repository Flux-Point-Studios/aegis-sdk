// Verify-only quote wrapper — real differential vs api/pricing_engine.py.
//
// These are NOT hand-authored expectations: every `barrier_valid`/`depeg_valid`
// premium below was produced by running the LIVE Python pricer
// (api/pricing_engine.py quote_barrier / quote_depeg) and frozen here as a
// golden. The reject cases are the exact strike/term boundaries at which the
// Python pricer raises PricingError. The wrapper must agree with the pricer on
// BOTH sides: accept what the API would build, reject what the API would refuse.
//
// To regenerate after a calibration change: re-run the pricer over these cases
// (see git history of _gen_golden.py) and update the premium/floorBps pins in
// lockstep with src/floor_table.ts. Any drift fails here, never on-chain.

import { describe, it, expect } from 'vitest';
import { quoteBarrier, quoteDepeg, quoteForPosition } from '../quote';

// ── Golden fixtures from api/pricing_engine.py (frozen 2026-06-17) ──────────
// [coverage, strike(1e6), spot(1e6), days, premium, floorBps, dBps]
const BARRIER_GOLDEN = [
  { coverage: 200_000_000n, strike: 600_000n, spot: 800_000n, days: 30, premium: 80_196_647n, floorBps: 2714, dBps: 2500 },
  { coverage: 1_000_000_000n, strike: 560_000n, spot: 800_000n, days: 14, premium: 78_967_674n, floorBps: 93, dBps: 3000 },
  { coverage: 500_000_000n, strike: 500_000n, spot: 1_000_000n, days: 60, premium: 60_227_593n, floorBps: 38, dBps: 5000 },
  { coverage: 100_000_000n, strike: 850_000n, spot: 1_000_000n, days: 7, premium: 28_170_761n, floorBps: 1203, dBps: 1500 },
  // non-ADA underlying (Surf ALT_LIQUID, σ=1.20): higher honest premium, SAME
  // asset-independent σ=0.95 on-chain floor — must still clear it.
  { coverage: 300_000_000n, strike: 700_000n, spot: 1_000_000n, days: 30, premium: 127_999_647n, floorBps: 934, dBps: 3000 },
] as const;

// [coverage, strike(1e6), days, premium, floorBps]
const DEPEG_GOLDEN = [
  { coverage: 1_000_000_000n, strike: 950_000n, days: 30, premium: 7_864_527n, floorBps: 78 },
  { coverage: 500_000_000n, strike: 900_000n, days: 90, premium: 11_719_646n, floorBps: 234 },
  { coverage: 1_000_000_000n, strike: 500_000n, days: 180, premium: 139_188_814n, floorBps: 464 },
] as const;

describe('quoteBarrier — differential vs pricing_engine.quote_barrier (real goldens)', () => {
  for (const g of BARRIER_GOLDEN) {
    it(`accepts d=${g.dBps}bps/${g.days}d and agrees on dBps+floorBps`, () => {
      const v = quoteBarrier({
        coverageLovelace: g.coverage,
        strikePriceScaled: g.strike,
        spotPriceScaled: g.spot,
        durationDays: g.days,
        premiumLovelace: g.premium,
      });
      expect(v.riskClass).toBe('Barrier');
      expect(v.dBps).toBe(g.dBps); // matches pricing_engine d_bps EXACTLY
      expect(v.tDays).toBe(g.days);
      expect(v.floorBps).toBe(g.floorBps); // matches the baked floor row
      expect(v.insurable).toBe(true);
      expect(v.reason).toBeNull();
      expect(v.premiumClearsFloor).toBe(true);
      // the real API premium must sit at/above the SDK floor and below coverage
      expect(g.premium).toBeGreaterThanOrEqual(v.floorLovelace);
      expect(g.premium).toBeLessThan(g.coverage);
    });
  }

  it('floorLovelace = ceil(coverage*floorBps/10000), matching the pricer clamp', () => {
    // coverage 200 ADA, floor 2714 bps → 54.28 ADA exactly.
    const v = quoteBarrier({
      coverageLovelace: 200_000_000n,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      durationDays: 30,
    });
    expect(v.floorLovelace).toBe(54_280_000n);
  });
});

describe('quoteBarrier — insurability gates (mirror pricing_engine raises)', () => {
  it('rejects below the 15% min strike distance (d=14.9%)', () => {
    const v = quoteBarrier({
      coverageLovelace: 100_000_000n,
      strikePriceScaled: 851_000n, // d = 14.9%
      spotPriceScaled: 1_000_000n,
      durationDays: 30,
    });
    expect(v.insurable).toBe(false);
    expect(v.reason).toContain('15%');
    expect(v.premiumClearsFloor).toBeNull();
  });

  it('rejects d=10%/365d as below-min (pricer: min-strike before dead-zone)', () => {
    const v = quoteBarrier({
      coverageLovelace: 100_000_000n,
      strikePriceScaled: 900_000n, // d = 10%
      spotPriceScaled: 1_000_000n,
      durationDays: 365,
    });
    expect(v.insurable).toBe(false);
    expect(v.reason).toContain('15%');
  });

  it('rejects the dead-zone: d=15% / T=120d (d<20% & T>90d)', () => {
    const v = quoteBarrier({
      coverageLovelace: 100_000_000n,
      strikePriceScaled: 850_000n, // d = 15%
      spotPriceScaled: 1_000_000n,
      durationDays: 120,
    });
    expect(v.insurable).toBe(false);
    expect(v.reason).toContain('dead zone');
  });

  it('rejects the mid dead-zone: d=22% / T=200d (d<25% & T>180d)', () => {
    const v = quoteBarrier({
      coverageLovelace: 100_000_000n,
      strikePriceScaled: 780_000n, // d = 22%
      spotPriceScaled: 1_000_000n,
      durationDays: 200,
    });
    expect(v.insurable).toBe(false);
    expect(v.reason).toContain('dead zone');
  });

  it('rejects a strike at/above spot (≤0 distance)', () => {
    const v = quoteBarrier({
      coverageLovelace: 100_000_000n,
      strikePriceScaled: 1_000_000n, // == spot
      spotPriceScaled: 1_000_000n,
      durationDays: 30,
    });
    expect(v.insurable).toBe(false);
    expect(v.reason).toContain('below the spot');
  });

  it('passes the exact d=20%/30d boundary (d<20% is strict; 2000bps is NOT dead-zone)', () => {
    const v = quoteBarrier({
      coverageLovelace: 200_000_000n,
      strikePriceScaled: 640_000n, // d = (800-640)/800 = 20% exactly → 2000 bps
      spotPriceScaled: 800_000n,
      durationDays: 120, // would be dead-zone iff d<20%
    });
    expect(v.dBps).toBe(2000);
    expect(v.insurable).toBe(true); // 2000 is NOT < 2000 → escapes dead-zone
    expect(v.reason).toBeNull();
  });
});

describe('quoteBarrier — supplied-premium verification', () => {
  it('rejects a premium below the on-chain floor', () => {
    const v = quoteBarrier({
      coverageLovelace: 200_000_000n,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      durationDays: 30, // floor = 54.28 ADA
      premiumLovelace: 10_000_000n, // 10 ADA — under floor
    });
    expect(v.insurable).toBe(false);
    expect(v.premiumClearsFloor).toBe(false);
    expect(v.reason).toContain('floor');
  });

  it('accepts a premium exactly at the floor (cross-multiply, no off-by-one)', () => {
    const v = quoteBarrier({
      coverageLovelace: 200_000_000n,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      durationDays: 30,
      premiumLovelace: 54_280_000n, // == floorLovelace
    });
    expect(v.insurable).toBe(true);
    expect(v.premiumClearsFloor).toBe(true);
  });

  it('rejects premium >= coverage as a guaranteed-loss product', () => {
    const v = quoteBarrier({
      coverageLovelace: 200_000_000n,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      durationDays: 30,
      premiumLovelace: 200_000_000n, // == coverage
    });
    expect(v.insurable).toBe(false);
    expect(v.reason).toContain('guaranteed-loss');
  });
});

describe('quoteBarrier — malformed inputs throw (programmer error, not a verdict)', () => {
  it('throws on non-positive coverage / spot / strike', () => {
    expect(() => quoteBarrier({ coverageLovelace: 0n, strikePriceScaled: 600_000n, spotPriceScaled: 800_000n, durationDays: 30 })).toThrow();
    expect(() => quoteBarrier({ coverageLovelace: 1n, strikePriceScaled: 600_000n, spotPriceScaled: 0n, durationDays: 30 })).toThrow();
    expect(() => quoteBarrier({ coverageLovelace: 1n, strikePriceScaled: 0n, spotPriceScaled: 800_000n, durationDays: 30 })).toThrow();
  });
});

describe('quoteDepeg — differential vs pricing_engine.quote_depeg (real goldens)', () => {
  for (const g of DEPEG_GOLDEN) {
    it(`accepts strike=${g.strike} / ${g.days}d and clears floor ${g.floorBps}bps`, () => {
      const v = quoteDepeg({
        coverageLovelace: g.coverage,
        strikePriceScaled: g.strike,
        durationDays: g.days,
        premiumLovelace: g.premium,
      });
      expect(v.riskClass).toBe('Depeg');
      expect(v.dBps).toBe(0);
      expect(v.tDays).toBe(g.days);
      expect(v.floorBps).toBe(g.floorBps);
      expect(v.insurable).toBe(true);
      expect(v.premiumClearsFloor).toBe(true);
    });
  }

  it('rejects a strike outside the [50%,95%] peg band', () => {
    const hi = quoteDepeg({ coverageLovelace: 100_000_000n, strikePriceScaled: 990_000n, durationDays: 30 });
    expect(hi.insurable).toBe(false);
    expect(hi.reason).toContain('peg');
    const lo = quoteDepeg({ coverageLovelace: 100_000_000n, strikePriceScaled: 400_000n, durationDays: 30 });
    expect(lo.insurable).toBe(false);
    expect(lo.reason).toContain('peg');
  });

  it('rejects a depeg premium below its hazard floor', () => {
    const v = quoteDepeg({
      coverageLovelace: 1_000_000_000n,
      strikePriceScaled: 950_000n,
      durationDays: 30, // floor 78 bps = 7.8 ADA
      premiumLovelace: 5_000_000n,
    });
    expect(v.insurable).toBe(false);
    expect(v.premiumClearsFloor).toBe(false);
  });
});

describe('quoteForPosition — dispatcher routes by risk class', () => {
  it('routes Barrier (requires spot)', () => {
    const v = quoteForPosition({
      riskClass: 'Barrier',
      coverageLovelace: 200_000_000n,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      durationDays: 30,
      premiumLovelace: 80_196_647n,
    });
    expect(v.riskClass).toBe('Barrier');
    expect(v.insurable).toBe(true);
  });

  it('routes Depeg (spot ignored)', () => {
    const v = quoteForPosition({
      riskClass: 'Depeg',
      coverageLovelace: 1_000_000_000n,
      strikePriceScaled: 950_000n,
      durationDays: 30,
      premiumLovelace: 7_864_527n,
    });
    expect(v.riskClass).toBe('Depeg');
    expect(v.insurable).toBe(true);
  });

  it('throws if a Barrier position omits spot', () => {
    expect(() =>
      quoteForPosition({
        riskClass: 'Barrier',
        coverageLovelace: 200_000_000n,
        strikePriceScaled: 600_000n,
        durationDays: 30,
      }),
    ).toThrow();
  });
});
