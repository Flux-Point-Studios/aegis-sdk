// V4 premium floor — a math-exact mirror of contracts/lib/aegis/floor_table.ak.
//
// This is the ON-CHAIN backstop the pool validator's Underwrite branch enforces.
// The SDK mirrors it so a partner gets a fail-fast "below floor" verdict instead
// of an opaque on-chain reject (a below-floor premium conjunction-fails with no
// trace). Integer-only — premium*10000 >= coverage*floorBps, identical to pool.ak;
// NO floats, so there is no truncation divergence from the chain.
//
// If the Aiken table is recalibrated (a validator change), regenerate from
// docs/pricing/gen_floor_tables.py and update src/__tests__/floor_table.test.ts
// cell pins in lockstep — the SDK must never hold a floor the chain doesn't.

/** price_scale (1e6) — USD prices and the $1 depeg peg are scaled by this. */
export const PRICE_SCALE = 1_000_000n;

/** Barrier strike must sit >= 15% below spot (floor_table.ak min_strike_distance_bps). */
export const MIN_STRIKE_DISTANCE_BPS = 1500;

/** Depeg insurable strike band, as a percent of the $1 peg. */
export const DEPEG_STRIKE_LO_PCT = 50;
export const DEPEG_STRIKE_HI_PCT = 95;

const MS_PER_DAY = 86_400_000n;

type Row7 = readonly [number, number, number, number, number, number, number];

/** T-band index 0..6, flooring to the lower edge {1,7,14,30,60,90,180}. */
export function tBandIndex(tDays: number): number {
  if (tDays < 7) return 0;
  if (tDays < 14) return 1;
  if (tDays < 30) return 2;
  if (tDays < 60) return 3;
  if (tDays < 90) return 4;
  if (tDays < 180) return 5;
  return 6;
}

function pick7(i: number, row: Row7): number {
  return row[i < 0 ? 0 : i > 6 ? 6 : i];
}

// Barrier floor rows, keyed by the d-band UPPER edge (ceil d to the grid).
const BARRIER_2000: Row7 = [0, 1203, 3083, 5512, 7494, 8463, 9776];
const BARRIER_2500: Row7 = [0, 397, 1686, 4009, 6256, 7432, 9088];
const BARRIER_3000: Row7 = [0, 96, 789, 2714, 5036, 6370, 8346];
const BARRIER_4000: Row7 = [0, 1, 93, 934, 2829, 4254, 6710];
const BARRIER_5000: Row7 = [0, 0, 3, 184, 1204, 2362, 4921];
const BARRIER_7000: Row7 = [0, 0, 0, 0, 38, 229, 1497];
const DEPEG_ROW: Row7 = [2, 18, 36, 78, 156, 234, 464];

/**
 * Minimum premium (bps of coverage) for a Barrier policy at strike distance
 * `dBps` (= 10000*(spot-strike)/spot) and duration `tDays`. Mirrors
 * floor_table.ak `barrier_floor_bps`. Fails closed (1_000_000) below the min
 * strike distance; 0 at/above 70% (only min_premium/ratio-cap apply there).
 */
export function barrierFloorBps(dBps: number, tDays: number): number {
  if (dBps < MIN_STRIKE_DISTANCE_BPS) return 1_000_000;
  const t = tBandIndex(tDays);
  if (dBps < 2000) return pick7(t, BARRIER_2000);
  if (dBps < 2500) return pick7(t, BARRIER_2500);
  if (dBps < 3000) return pick7(t, BARRIER_3000);
  if (dBps < 4000) return pick7(t, BARRIER_4000);
  if (dBps < 5000) return pick7(t, BARRIER_5000);
  if (dBps < 7000) return pick7(t, BARRIER_7000);
  return 0;
}

/** Minimum premium (bps of coverage) for a Depeg policy of duration `tDays`. */
export function depegFloorBps(tDays: number): number {
  return pick7(tBandIndex(tDays), DEPEG_ROW);
}

/** premium/coverage >= floor/10000, cross-multiplied (integer; no truncation games). */
export function meetsBarrierFloor(
  premium: bigint,
  coverage: bigint,
  dBps: number,
  tDays: number,
): boolean {
  return premium * 10_000n >= coverage * BigInt(barrierFloorBps(dBps, tDays));
}

export function meetsDepegFloor(premium: bigint, coverage: bigint, tDays: number): boolean {
  return premium * 10_000n >= coverage * BigInt(depegFloorBps(tDays));
}

/** Is a Depeg strike inside the insurable [50%,95%]-of-peg band? */
export function depegStrikeInBand(strikePriceScaled: bigint): boolean {
  return (
    strikePriceScaled >= (PRICE_SCALE * BigInt(DEPEG_STRIKE_LO_PCT)) / 100n &&
    strikePriceScaled <= (PRICE_SCALE * BigInt(DEPEG_STRIKE_HI_PCT)) / 100n
  );
}

/**
 * Barrier strike distance in bps, derived exactly as the validator does
 * (pool.ak:579): d_bps = (spot - strike) * 10000 / spot, integer floor, on the
 * 1e6-scaled prices. A strike above spot yields a value < the min strike
 * distance (i.e. uninsurable).
 */
export function barrierDBps(spotScaled: bigint, strikePriceScaled: bigint): number {
  if (spotScaled <= 0n) throw new Error('spot price must be positive');
  return Number(((spotScaled - strikePriceScaled) * 10_000n) / spotScaled);
}

/** Duration in days, validator-exact (pool.ak:546): (expiry-start)/86_400_000, floored. */
export function durationDays(startMs: bigint, expiryMs: bigint): number {
  if (expiryMs <= startMs) throw new Error('expiry must be after start');
  return Number((expiryMs - startMs) / MS_PER_DAY);
}
