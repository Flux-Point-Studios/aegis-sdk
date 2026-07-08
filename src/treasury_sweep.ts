// treasury_sweep.ts — the periodic, key-witnessed treasury-donation sweep
// (V7 conditional donation). The COMPOSED underwrite path omits the Conway
// key-22 (treasury_share_bps stays 2500 on-chain and a PRESENT donation is
// still enforced ≥ the cut, but an ABSENT one is accepted — so a PlutusV2
// cardano-swaps fill can ride the same tx). The treasury's % is instead
// BATCHED here: one tx that spends N accumulated team-fee UTxOs and sets the
// Conway `treasury_donation` body field (CDDL key 22) to the reconciled cut.
//
// The sweep carries NO PlutusV2 script — only a key witness (or, in future, a
// V3 treasury validator). That is the whole point: a key-witnessed / V3-only tx
// builds a script context that CAN represent key 22, so the donation is legal
// here even though it is forbidden on the V2-bearing swap tx. This is the exact
// inverse of the composition constraint the swap assembler enforces.
//
// The accrual model mirrors SaturnSwapBackend
// Modules/Insurance/Services/PartnerAccrualReconciler.cs — sum the per-policy
// cuts reconstructed from chain, settle periodically. Reuse, not a new
// primitive: each per-policy cut is `calculateTreasuryCut` at the sweep share,
// so the sweep total is bit-consistent with the fee math the composer uses.

import { calculateTreasuryCut, TREASURY_SWEEP_SHARE_BPS } from './fees';
import type { RefUtxo } from './compose';
import { InputError } from './errors';

/**
 * One reconciled fee-bearing event (an underwritten policy) whose treasury
 * share is owed to the Cardano treasury. Reconstructed off-chain from the
 * policy datum's `premium_paid` and the pool's `protocol_fee_bps` — the twin of
 * `PartnerAccrualReconciler` summing `PolicyDatum.partnerCutLovelace`.
 */
export interface TreasuryAccrual {
  premiumLovelace: bigint;
  protocolFeeBps: bigint;
}

/**
 * Treasury cut owed for a single accrued fee event, at the sweep share (the
 * value the on-chain const held before the Phase-4 rotation). Two-stage floor,
 * identical to the composer's `calculateTreasuryCut` — so a swept total never
 * drifts from what the per-underwrite path would have carved.
 */
export function treasuryCutForAccrual(a: TreasuryAccrual): bigint {
  return calculateTreasuryCut(a.premiumLovelace, a.protocolFeeBps, TREASURY_SWEEP_SHARE_BPS);
}

/**
 * Reconcile the batched treasury cut owed across every accrued fee event since
 * the last sweep. This is the lovelace the sweep tx donates via Conway key 22.
 * For inputs whose raw fee is divisible this equals 25% of the accumulated raw
 * protocol fees (the "25% of accumulated fees" headline).
 *
 * CALLER CONTRACT (load-bearing — see the conditional-donation red-team): because
 * a covered-swap underwrite omits the on-chain donation and NO on-chain field
 * records paid-vs-owed, `accruals` MUST be the FULL history of donation-omitted
 * policies reconstructed from spent-output `premium_paid` (and `cancellation_fee`
 * for cancels) — NOT a live-UTxO snapshot. A snapshot silently under-collects:
 * closed and short-lived policies (opened and cancelled/claimed/expired between
 * two scans) have burned their marker + spent their UTxO and are invisible to a
 * snapshot, and there is no on-chain way to tell an already-donated policy from
 * one still owing. Feed a stateful full-history indexer, and count the cancel's
 * SECOND (cancellation-fee-derived) cut.
 */
export function reconcileTreasurySweep(accruals: readonly TreasuryAccrual[]): bigint {
  let total = 0n;
  for (const a of accruals) total += treasuryCutForAccrual(a);
  return total;
}

/**
 * The spliceable parts of a treasury-sweep tx. A partner/operator's own builder
 * (Lucid, MeshJS, cardano-cli) turns these into a signed tx. Deliberately NOT a
 * full tx (the SDK has no wallet / chain / tx framework) — it is the exact,
 * key-witnessed shape the builder must produce.
 */
export interface TreasurySweepParts {
  /** Conway `treasury_donation` (CDDL key 22) — the reconciled batched cut. */
  treasuryDonationLovelace: bigint;
  /** Accumulated team/treasury fee UTxOs to spend. These sit at a plain KEY
   *  address (or a V3-only treasury validator) — NEVER a PlutusV2 script. */
  feeInputs: RefUtxo[];
  /** Where change (accumulated fees − donation − tx fee) returns. */
  changeAddress: string;
  /** Payment key hash(es) that must sign. Key-witnessed — this is the whole
   *  authorization; there is no script to satisfy. */
  requiredSigners: string[];
  /** ALWAYS empty: the sweep carries NO Plutus script witness. This invariant
   *  is what lets the tx's script context represent Conway key 22. */
  plutusScripts: readonly never[];
}

export interface BuildTreasurySweepPartsParams {
  /** The reconciled fee-bearing events to settle (from the accrual reconciler). */
  accruals: readonly TreasuryAccrual[];
  /** Accumulated team-fee UTxOs available to fund the donation + change. */
  feeInputs: RefUtxo[];
  /** Treasury/team change address (bech32). */
  changeAddress: string;
  /** 28-byte (56-hex) payment key hash of the treasury/team wallet — the signer. */
  treasuryKeyHash: string;
  /** Total lovelace held across `feeInputs`. Guards that the sweep can fund the
   *  donation (the donation is paid FROM the accumulated fees, not extra). */
  availableLovelace: bigint;
}

/**
 * Build the parts for a periodic treasury-sweep tx. Throws (never emits parts
 * that would fail on chain) when there is nothing to sweep, the inputs cannot
 * fund the reconciled donation, or the signer hash is malformed.
 */
export function buildTreasurySweepParts(params: BuildTreasurySweepPartsParams): TreasurySweepParts {
  const { accruals, feeInputs, changeAddress, treasuryKeyHash, availableLovelace } = params;

  if (!treasuryKeyHash || treasuryKeyHash.length !== 56) {
    throw new InputError('INVALID_INPUT', `treasuryKeyHash must be 56 hex chars (28 bytes), got ${treasuryKeyHash?.length ?? 0}`);
  }
  if (feeInputs.length === 0) {
    throw new InputError('INVALID_INPUT', 'no fee inputs to sweep');
  }
  if (!changeAddress) {
    throw new InputError('INVALID_INPUT', 'changeAddress is required');
  }

  const treasuryDonationLovelace = reconcileTreasurySweep(accruals);
  if (treasuryDonationLovelace <= 0n) {
    throw new InputError('NOTHING_TO_SWEEP', 'reconciled treasury cut is 0 — nothing to sweep');
  }
  if (treasuryDonationLovelace > availableLovelace) {
    throw new InputError('INSUFFICIENT_FEES',
      `accumulated fees ${availableLovelace} cannot fund the reconciled treasury donation ${treasuryDonationLovelace}`);
  }

  return {
    treasuryDonationLovelace,
    feeInputs,
    changeAddress,
    requiredSigners: [treasuryKeyHash],
    plutusScripts: [],
  };
}
