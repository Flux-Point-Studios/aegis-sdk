// Verify-only insurability quote — a fail-fast mirror of api/pricing_engine.py's
// product gates, layered on the validator-exact floor in floor_table.ts.
//
// WHY verify-only (not a re-priced GBM/erf): the exact actuarial premium is the
// API's job (pricing_engine.quote_barrier, an erf/exp closed form). Re-deriving
// it in floating point here would risk sub-bps divergence that pushes an honest
// premium fractionally below the integer on-chain floor — a self-inflicted DoS.
// So a partner fetches the premium from the Aegis API, then calls this to get a
// deterministic "will the chain accept this exact (premium, coverage, strike,
// term)?" verdict BEFORE composing the underwrite tx. The verdict carries a
// machine-readable `reasonCode` (shared with AegisError) so partners can branch
// without string-matching.
//
// The σ (SIGMA_BY_ASSET) and erf math in pricing_engine do NOT enter here: the
// on-chain floor table is asset-independent (one σ=0.95-baked table the
// validator enforces for every barrier). Verify-only is correct for all assets.
//
// Gate constants mirror api/pricing_engine.py EXACTLY.

import type { RiskClass } from './types';
import { InputError, type AegisErrorCode } from './errors';
import {
  MIN_STRIKE_DISTANCE_BPS,
  barrierFloorBps,
  depegFloorBps,
  meetsBarrierFloor,
  meetsDepegFloor,
  depegStrikeInBand,
  barrierDBps,
} from './floor_table';

/** Dead-zone gate (pricing_engine.py:50-53). */
export const DEAD_ZONE_SHALLOW_D_BPS = 2000; // d < 20%
export const DEAD_ZONE_SHALLOW_T = 90; // days
export const DEAD_ZONE_MID_D_BPS = 2500; // d < 25%
export const DEAD_ZONE_MID_T = 180; // days

/** The verdict of a verify-only quote. Check `insurable` first; branch on
 *  `reasonCode` (machine-readable) rather than the human `reason` string. */
export interface QuoteVerdict {
  riskClass: RiskClass;
  /** Barrier strike distance in bps (validator-exact); 0 for Depeg. */
  dBps: number;
  /** Integer day-band used for the floor lookup (floor of durationDays). */
  tDays: number;
  /** On-chain floor in bps of coverage the premium must clear. */
  floorBps: number;
  /** Minimum premium (lovelace) the validator accepts = ceil(coverage*floorBps/10000). */
  floorLovelace: bigint;
  /** True iff this exact policy would be accepted. */
  insurable: boolean;
  /** null when insurable; otherwise the named gate that rejected it. */
  reason: string | null;
  /** null when insurable; otherwise the machine-readable rejection code. */
  reasonCode: AegisErrorCode | null;
  /** null unless a premium was supplied; then whether it clears the on-chain floor. */
  premiumClearsFloor: boolean | null;
}

/** ceil(coverage * floorBps / 10000) — matches pricing_engine's ceil-div clamp. */
function floorLovelaceOf(coverage: bigint, floorBps: number): bigint {
  return (coverage * BigInt(floorBps) + 9_999n) / 10_000n;
}

export function quoteBarrier(params: {
  coverageLovelace: bigint;
  strikePriceScaled: bigint;
  spotPriceScaled: bigint;
  durationDays: number;
  premiumLovelace?: bigint;
}): QuoteVerdict {
  const { coverageLovelace, strikePriceScaled, spotPriceScaled, durationDays, premiumLovelace } =
    params;

  if (coverageLovelace <= 0n) throw new InputError('INVALID_INPUT', 'coverage must be positive');
  if (spotPriceScaled <= 0n) throw new InputError('INVALID_INPUT', 'spot price must be positive');
  if (strikePriceScaled <= 0n) throw new InputError('INVALID_INPUT', 'strike price must be positive');

  const tDays = Math.floor(durationDays);
  const dBps = barrierDBps(spotPriceScaled, strikePriceScaled); // ≤0 if strike ≥ spot
  const floorBps = barrierFloorBps(dBps, tDays);
  const floorLovelace = floorLovelaceOf(coverageLovelace, floorBps);

  const reject = (
    reason: string,
    reasonCode: AegisErrorCode,
    premiumClearsFloor: boolean | null = null,
  ): QuoteVerdict => ({
    riskClass: 'Barrier',
    dBps,
    tDays,
    floorBps,
    floorLovelace,
    insurable: false,
    reason,
    reasonCode,
    premiumClearsFloor,
  });

  // Gate 1 — minimum strike distance (15%). dBps ≤ 0 means strike ≥ spot.
  if (dBps < MIN_STRIKE_DISTANCE_BPS) {
    return dBps <= 0
      ? reject('strike must be below the spot price', 'STRIKE_NOT_BELOW_SPOT')
      : reject(
          `strike distance ${(dBps / 100).toFixed(1)}% is below the 15% minimum — choose a deeper strike`,
          'BELOW_MIN_STRIKE_DISTANCE',
        );
  }

  // Gate 2 — dead-zone (uses the raw, unbanded durationDays, like the pricer).
  const inDeadZone =
    (dBps < DEAD_ZONE_SHALLOW_D_BPS && durationDays > DEAD_ZONE_SHALLOW_T) ||
    (dBps < DEAD_ZONE_MID_D_BPS && durationDays > DEAD_ZONE_MID_T);
  if (inDeadZone) {
    return reject(
      `d=${(dBps / 100).toFixed(1)}% / T=${tDays}d is in the economically dead zone ` +
        `(premium would exceed ~half the coverage) — choose a deeper strike or a shorter term`,
      'DEAD_ZONE',
    );
  }

  // The position is insurable. If a premium was supplied, verify it too.
  if (premiumLovelace !== undefined) {
    if (premiumLovelace >= coverageLovelace) {
      return reject('premium ≥ coverage — this is a guaranteed-loss product and cannot be built', 'PREMIUM_GE_COVERAGE', false);
    }
    if (!meetsBarrierFloor(premiumLovelace, coverageLovelace, dBps, tDays)) {
      return reject(`premium is below the on-chain floor (need ≥ ${floorLovelace} lovelace)`, 'BELOW_FLOOR', false);
    }
    return { riskClass: 'Barrier', dBps, tDays, floorBps, floorLovelace, insurable: true, reason: null, reasonCode: null, premiumClearsFloor: true };
  }

  return { riskClass: 'Barrier', dBps, tDays, floorBps, floorLovelace, insurable: true, reason: null, reasonCode: null, premiumClearsFloor: null };
}

export function quoteDepeg(params: {
  coverageLovelace: bigint;
  strikePriceScaled: bigint;
  durationDays: number;
  premiumLovelace?: bigint;
}): QuoteVerdict {
  const { coverageLovelace, strikePriceScaled, durationDays, premiumLovelace } = params;
  if (coverageLovelace <= 0n) throw new InputError('INVALID_INPUT', 'coverage must be positive');

  const tDays = Math.floor(durationDays);
  const floorBps = depegFloorBps(tDays);
  const floorLovelace = floorLovelaceOf(coverageLovelace, floorBps);

  if (!depegStrikeInBand(strikePriceScaled)) {
    return {
      riskClass: 'Depeg', dBps: 0, tDays, floorBps, floorLovelace,
      insurable: false,
      reason: 'depeg strike must sit in [50%, 95%] of the $1 peg',
      reasonCode: 'DEPEG_STRIKE_OUT_OF_BAND',
      premiumClearsFloor: null,
    };
  }

  if (premiumLovelace !== undefined) {
    if (!meetsDepegFloor(premiumLovelace, coverageLovelace, tDays)) {
      return {
        riskClass: 'Depeg', dBps: 0, tDays, floorBps, floorLovelace,
        insurable: false,
        reason: `premium is below the on-chain depeg floor (need ≥ ${floorLovelace} lovelace)`,
        reasonCode: 'BELOW_FLOOR',
        premiumClearsFloor: false,
      };
    }
    return { riskClass: 'Depeg', dBps: 0, tDays, floorBps, floorLovelace, insurable: true, reason: null, reasonCode: null, premiumClearsFloor: true };
  }

  return { riskClass: 'Depeg', dBps: 0, tDays, floorBps, floorLovelace, insurable: true, reason: null, reasonCode: null, premiumClearsFloor: null };
}

/**
 * Dispatcher — route a position to the right engine by risk class. Barrier
 * positions require `spotPriceScaled`; Depeg ignores it.
 */
export function quoteForPosition(params: {
  riskClass: RiskClass;
  coverageLovelace: bigint;
  strikePriceScaled: bigint;
  spotPriceScaled?: bigint;
  durationDays: number;
  premiumLovelace?: bigint;
}): QuoteVerdict {
  if (params.riskClass === 'Depeg') {
    return quoteDepeg({
      coverageLovelace: params.coverageLovelace,
      strikePriceScaled: params.strikePriceScaled,
      durationDays: params.durationDays,
      premiumLovelace: params.premiumLovelace,
    });
  }
  if (params.spotPriceScaled === undefined) {
    throw new InputError('MISSING_SPOT', 'Barrier quote requires spotPriceScaled');
  }
  return quoteBarrier({
    coverageLovelace: params.coverageLovelace,
    strikePriceScaled: params.strikePriceScaled,
    spotPriceScaled: params.spotPriceScaled,
    durationDays: params.durationDays,
    premiumLovelace: params.premiumLovelace,
  });
}
