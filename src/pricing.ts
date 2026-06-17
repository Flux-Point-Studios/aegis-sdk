/**
 * D:\aegis\sdk\src\pricing.ts
 *
 * Pure premium calculation engine with zero runtime dependencies.
 *
 * Implements the Aegis actuarial pricing model that matches the off-chain
 * Python pricing in offchain/src/aegis/pricing.py. The on-chain validator
 * only checks minimum premium (2 ADA) and max coverage ratio (50x); the
 * full calculation lives here and in the Python equivalent.
 *
 * Formula: premium = coverage * baseRate * durationMult * utilFactor
 *
 * Used by: aegis.ts (buildPolicyOutput), and directly by integrators who
 * want to preview premiums without hitting the REST API.
 */

import type { PremiumResult } from './types';

// ---------------------------------------------------------------------------
// Pricing tables -- must match offchain/src/aegis/pricing.py
// ---------------------------------------------------------------------------

/**
 * Base rate table: [maxDistance, rate]
 * Lower distance from strike to current price = higher payout probability = higher rate.
 *
 * Matches the Python BASE_RATE_TABLE in pricing.py:
 *   < 10% -> 8.0%,  < 20% -> 4.0%,  < 30% -> 2.0%
 *   < 40% -> 1.0%,  < 50% -> 0.5%,  >= 50% -> 0.25%
 */
const BASE_RATE_TABLE: ReadonlyArray<[number, number]> = [
  [0.10, 0.080],
  [0.20, 0.040],
  [0.30, 0.020],
  [0.40, 0.010],
  [0.50, 0.005],
  [1.00, 0.0025],
];

/**
 * Duration multiplier breakpoints: [days, multiplier]
 * Longer coverage = higher premium, but sublinear (sqrt-like).
 *
 * Matches the Python DURATION_MULTIPLIER_TABLE:
 *   1d -> 1.0x,  3d -> 2.0x,  7d -> 3.5x,  14d -> 5.0x,  30d -> 8.0x
 * Values between breakpoints are linearly interpolated.
 */
const DURATION_TABLE: ReadonlyArray<[number, number]> = [
  [1, 1.0],
  [3, 2.0],
  [7, 3.5],
  [14, 5.0],
  [30, 8.0],
];

/**
 * Utilization factor breakpoints: [maxUtilization, factor]
 * Higher pool utilization = scarcity pricing.
 *
 * Matches the Python UTILIZATION_FACTOR_TABLE:
 *   < 30% -> 1.0x,  < 50% -> 1.2x,  < 70% -> 1.5x
 *   < 85% -> 2.0x,  >= 85% -> 3.0x
 */
const UTIL_FACTOR_TABLE: ReadonlyArray<[number, number]> = [
  [0.30, 1.0],
  [0.50, 1.2],
  [0.70, 1.5],
  [0.85, 2.0],
  [1.00, 3.0],
];

/** Minimum premium in lovelace (2 ADA). Must match on-chain min_premium. */
const MIN_PREMIUM_LOVELACE = 2_000_000n;

/** Maximum coverage-to-premium ratio. Must match on-chain max_coverage_ratio. */
const MAX_COVERAGE_RATIO = 50;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Calculate strike distance: how far the strike price is below current price.
 * Returns a fraction between 0 and 1. Returns 0 if strike >= current (immediate risk).
 */
function strikeDistanceFraction(currentPrice: number, strikePrice: number): number {
  if (currentPrice <= 0) {
    throw new Error('currentPrice must be positive');
  }
  if (strikePrice <= 0) {
    throw new Error('strikePrice must be positive');
  }
  if (strikePrice >= currentPrice) {
    return 0;
  }
  return (currentPrice - strikePrice) / currentPrice;
}

/**
 * Look up the base rate from the strike distance using the step-function table.
 */
function lookupBaseRate(distance: number): number {
  for (const [maxDist, rate] of BASE_RATE_TABLE) {
    if (distance < maxDist) {
      return rate;
    }
  }
  return BASE_RATE_TABLE[BASE_RATE_TABLE.length - 1][1];
}

/**
 * Interpolate the duration multiplier between breakpoints.
 * Below the first breakpoint returns the first value.
 * Above the last breakpoint extrapolates linearly from the last two points.
 */
function interpolateDuration(days: number): number {
  if (days <= 0) {
    throw new Error('durationDays must be positive');
  }

  const table = DURATION_TABLE;

  // Below first breakpoint
  if (days <= table[0][0]) {
    return table[0][1];
  }

  // Above last breakpoint -- extrapolate
  if (days >= table[table.length - 1][0]) {
    const [d0, m0] = table[table.length - 2];
    const [d1, m1] = table[table.length - 1];
    const slope = (m1 - m0) / (d1 - d0);
    return m1 + slope * (days - d1);
  }

  // Between breakpoints -- linear interpolation
  for (let i = 0; i < table.length - 1; i++) {
    const [d0, m0] = table[i];
    const [d1, m1] = table[i + 1];
    if (d0 <= days && days <= d1) {
      const fraction = (days - d0) / (d1 - d0);
      return m0 + fraction * (m1 - m0);
    }
  }

  return table[table.length - 1][1];
}

/**
 * Look up the utilization factor from pool utilization using the step-function table.
 */
function lookupUtilFactor(utilization: number): number {
  for (const [maxUtil, factor] of UTIL_FACTOR_TABLE) {
    if (utilization < maxUtil) {
      return factor;
    }
  }
  return UTIL_FACTOR_TABLE[UTIL_FACTOR_TABLE.length - 1][1];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate the insurance premium for an Aegis policy.
 *
 * This is a pure function with zero dependencies -- safe to run in any
 * environment (browser, Node, Deno, service worker).
 *
 * The result includes the premium in lovelace (minimum 2 ADA) and the
 * full breakdown of risk factors for transparency.
 *
 * @param params.coverageLovelace - Coverage amount in lovelace
 * @param params.strikePrice      - Strike price in USD (e.g. 0.20)
 * @param params.currentPrice     - Current ADA/USD price (e.g. 0.258)
 * @param params.durationDays     - Policy duration in days (e.g. 30)
 * @param params.poolUtilization  - Pool utilization fraction 0-1 (e.g. 0.3)
 *
 * @returns PremiumResult with premiumLovelace and factor breakdown
 *
 * @example
 * ```ts
 * const result = calculatePremium({
 *   coverageLovelace: 500_000_000n,  // 500 ADA
 *   strikePrice: 0.20,
 *   currentPrice: 0.258,
 *   durationDays: 30,
 *   poolUtilization: 0.3,
 * });
 * console.log(`Premium: ${result.premiumLovelace} lovelace`);
 * ```
 */
export function calculatePremium(params: {
  coverageLovelace: bigint;
  strikePrice: number;
  currentPrice: number;
  durationDays: number;
  poolUtilization: number;
}): PremiumResult {
  const { coverageLovelace, strikePrice, currentPrice, durationDays, poolUtilization } = params;

  // Validate inputs
  if (coverageLovelace <= 0n) {
    throw new Error('coverageLovelace must be positive');
  }
  if (durationDays <= 0) {
    throw new Error('durationDays must be positive');
  }
  if (poolUtilization < 0 || poolUtilization > 1) {
    throw new Error('poolUtilization must be between 0 and 1');
  }

  // Calculate risk factors
  const distance = strikeDistanceFraction(currentPrice, strikePrice);
  const baseRate = lookupBaseRate(distance);
  const durationMult = interpolateDuration(durationDays);
  const utilFactor = lookupUtilFactor(poolUtilization);

  // Calculate raw premium
  const coverageNumber = Number(coverageLovelace);
  let premium = coverageNumber * baseRate * durationMult * utilFactor;

  // Enforce minimum premium (2 ADA)
  premium = Math.max(premium, Number(MIN_PREMIUM_LOVELACE));

  // Enforce max coverage ratio (50x)
  if (premium > 0) {
    const ratio = coverageNumber / premium;
    if (ratio > MAX_COVERAGE_RATIO) {
      premium = coverageNumber / MAX_COVERAGE_RATIO;
    }
  }

  const premiumLovelace = BigInt(Math.max(Math.round(premium), Number(MIN_PREMIUM_LOVELACE)));

  return {
    premiumLovelace,
    baseRate,
    durationMult,
    utilFactor,
    strikeDistance: distance,
  };
}
