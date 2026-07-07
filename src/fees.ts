// V12.2 fee / treasury math — a bigint mirror of the off-chain Python
// (api/policies.py calculate_fee_total / calculate_net_pool_growth /
// calculate_protocol_fee_split, api/_treasury.py calculate_treasury_cut),
// which in turn mirror contracts/lib/aegis/pricing.ak byte-for-byte.
//
// The pool validator's Underwrite branch reads the pool/team/partner output
// values and the Conway treasury_donation body field to the lovelace, so the
// composer MUST agree with the validator exactly. Integer-only (bigint); the
// two-stage treasury division floors at each step, NOT collapsed (it diverges
// by 1 lovelace otherwise — see api/_treasury.py docstring).

import { MIN_UTXO_LOVELACE } from './constants';

/** Per-underwrite treasury share (bps of the protocol fee). Mirrors the
 *  compile-time const on the Aiken side (types.ak::treasury_share_bps).
 *
 *  ROTATED TO 0 (Option C Phase 4 — treasury-donation decouple). With the share
 *  at zero, `calculateTreasuryCut` returns 0 for every premium, so the Underwrite
 *  tx carries NO Conway `treasury_donation` (CDDL key 22) and a V2 cardano-swaps
 *  fill can share the same tx (key 22 in the body poisons the V2 script context
 *  and fails phase-2). The treasury's % is settled OFF the swap path by a periodic
 *  key-witnessed sweep tx — see `TREASURY_SWEEP_SHARE_BPS` / `treasury_sweep.ts`. */
export const TREASURY_SHARE_BPS = 0n;

/** Treasury share (bps of the protocol fee) settled by the periodic, key-witnessed
 *  treasury-sweep tx rather than per-underwrite. This is the value the on-chain
 *  const held BEFORE the Phase-4 rotation (25% of the 2% fee = 0.5% of premium);
 *  it now lives only on the sweep path, which sets Conway key 22 legally because
 *  the sweep carries no PlutusV2 script. */
export const TREASURY_SWEEP_SHARE_BPS = 2_500n;

function assertNonNeg(...xs: bigint[]): void {
  for (const x of xs) if (x < 0n) throw new Error('fee inputs must be non-negative');
}

/**
 * fee_total = max(MIN_UTXO_LOVELACE, premium*feeBps/10000), with the explicit
 * short-circuit that a zero raw fee yields 0 (no floor activation) — matches
 * the Aiken spec and the "no fee output when fee_total == 0" downstream branch.
 */
export function calculateFeeTotal(premiumLovelace: bigint, feeBps: bigint): bigint {
  assertNonNeg(premiumLovelace, feeBps);
  const raw = (premiumLovelace * feeBps) / 10_000n;
  if (raw <= 0n) return 0n;
  return raw > MIN_UTXO_LOVELACE ? raw : MIN_UTXO_LOVELACE;
}

/** premium − fee_total: the lovelace the pool's continuation UTxO grows by AND
 *  the increment to PoolDatum.total_liquidity (both validator-enforced). */
export function calculateNetPoolGrowth(premiumLovelace: bigint, feeBps: bigint): bigint {
  return premiumLovelace - calculateFeeTotal(premiumLovelace, feeBps);
}

/**
 * (teamCut, partnerCut) under V12.2 Hybrid Fee math. The floor lives inside the
 * carve (fee_total = max(MIN_UTXO, raw)); a partner cut below MIN_UTXO is
 * silently absorbed into the team cut so no sub-min-utxo partner output is
 * emitted. Invariant: teamCut + partnerCut == fee_total always.
 */
export function calculateProtocolFeeSplit(
  premiumLovelace: bigint,
  feeBps: bigint,
  partnerShareBps: bigint,
): { teamCut: bigint; partnerCut: bigint } {
  assertNonNeg(premiumLovelace, feeBps, partnerShareBps);
  const feeTotal = calculateFeeTotal(premiumLovelace, feeBps);
  if (feeTotal === 0n) return { teamCut: 0n, partnerCut: 0n };
  const partnerRaw = (feeTotal * partnerShareBps) / 10_000n;
  const partnerCut = partnerRaw >= MIN_UTXO_LOVELACE ? partnerRaw : 0n;
  return { teamCut: feeTotal - partnerCut, partnerCut };
}

/**
 * Lovelace owed to the Cardano treasury (Conway donation body field) for an
 * Underwrite-class fee event = amount*protocol_fee_bps/10000 * share/10000.
 * Two-stage floor — do NOT collapse the divisions (bit-divergent otherwise).
 */
export function calculateTreasuryCut(
  amountLovelace: bigint,
  protocolFeeBps: bigint,
  treasuryShareBps: bigint = TREASURY_SHARE_BPS,
): bigint {
  assertNonNeg(amountLovelace, protocolFeeBps, treasuryShareBps);
  return ((amountLovelace * protocolFeeBps) / 10_000n) * treasuryShareBps / 10_000n;
}
