// Treasury-sweep tests (Option C Phase 4). The sweep is the batched, key-
// witnessed home of the treasury cut that the per-underwrite path no longer
// carves. Two things must hold: (1) the amount math reconciles the per-policy
// cuts exactly (= 25% of accumulated raw fees for divisible inputs), and (2)
// the produced tx-parts carry NO Plutus script witness — that is what lets the
// sweep set Conway key 22 legally.

import { describe, it, expect } from 'vitest';
import {
  buildTreasurySweepParts,
  reconcileTreasurySweep,
  treasuryCutForAccrual,
  type TreasuryAccrual,
} from '../treasury_sweep';
import { calculateTreasuryCut, TREASURY_SWEEP_SHARE_BPS } from '../fees';

const KEY_HASH = 'ab'.repeat(28); // 56 hex = 28-byte payment key hash
const CHANGE = 'addr_test1_treasury';
const feeUtxo = (i: number) => ({ txHash: 'cd'.repeat(32), index: i });

// premium=100 ADA @2% → raw fee 2 ADA → 25% = 0.5 ADA
const A: TreasuryAccrual = { premiumLovelace: 100_000_000n, protocolFeeBps: 200n };
// premium=500 ADA @2% → raw fee 10 ADA → 25% = 2.5 ADA
const B: TreasuryAccrual = { premiumLovelace: 500_000_000n, protocolFeeBps: 200n };

describe('treasury sweep — amount math (reconciler-faithful)', () => {
  it('per-accrual cut = two-stage cut at the sweep share', () => {
    expect(treasuryCutForAccrual(A)).toBe(500_000n);
    expect(treasuryCutForAccrual(B)).toBe(2_500_000n);
    expect(treasuryCutForAccrual(A)).toBe(
      calculateTreasuryCut(A.premiumLovelace, A.protocolFeeBps, TREASURY_SWEEP_SHARE_BPS),
    );
  });

  it('reconcile sums the per-policy cuts', () => {
    expect(reconcileTreasurySweep([A, B])).toBe(3_000_000n);
    expect(reconcileTreasurySweep([])).toBe(0n);
    expect(reconcileTreasurySweep([A, A, A])).toBe(1_500_000n);
  });

  it('for divisible inputs the total equals 25% of accumulated raw fees', () => {
    const rawFees = (A.premiumLovelace * 200n) / 10_000n + (B.premiumLovelace * 200n) / 10_000n; // 12 ADA
    const twentyFivePct = (rawFees * TREASURY_SWEEP_SHARE_BPS) / 10_000n; // 3 ADA
    expect(reconcileTreasurySweep([A, B])).toBe(twentyFivePct);
  });
});

describe('treasury sweep — tx parts (key-witnessed, NO script)', () => {
  it('emits the reconciled donation, the signer, and NO plutus script witness', () => {
    const parts = buildTreasurySweepParts({
      accruals: [A, B],
      feeInputs: [feeUtxo(0), feeUtxo(1)],
      changeAddress: CHANGE,
      treasuryKeyHash: KEY_HASH,
      availableLovelace: 20_000_000n,
    });
    expect(parts.treasuryDonationLovelace).toBe(3_000_000n);
    expect(parts.requiredSigners).toEqual([KEY_HASH]);
    expect(parts.feeInputs).toHaveLength(2);
    expect(parts.changeAddress).toBe(CHANGE);
    // THE invariant: no PlutusV2 (or any Plutus) script rides the sweep, so its
    // script context can represent Conway key 22.
    expect(parts.plutusScripts).toHaveLength(0);
  });

  it('throws when there is nothing to sweep', () => {
    expect(() =>
      buildTreasurySweepParts({
        accruals: [],
        feeInputs: [feeUtxo(0)],
        changeAddress: CHANGE,
        treasuryKeyHash: KEY_HASH,
        availableLovelace: 20_000_000n,
      }),
    ).toThrow(/nothing to sweep/i);
  });

  it('throws when accumulated fees cannot fund the reconciled donation', () => {
    expect(() =>
      buildTreasurySweepParts({
        accruals: [A, B],
        feeInputs: [feeUtxo(0)],
        changeAddress: CHANGE,
        treasuryKeyHash: KEY_HASH,
        availableLovelace: 1_000_000n, // < 3 ADA owed
      }),
    ).toThrow(/cannot fund/i);
  });

  it('rejects a malformed signer key hash, missing inputs, and missing change', () => {
    expect(() =>
      buildTreasurySweepParts({ accruals: [A], feeInputs: [feeUtxo(0)], changeAddress: CHANGE, treasuryKeyHash: 'ab', availableLovelace: 20_000_000n }),
    ).toThrow(/56 hex/);
    expect(() =>
      buildTreasurySweepParts({ accruals: [A], feeInputs: [], changeAddress: CHANGE, treasuryKeyHash: KEY_HASH, availableLovelace: 20_000_000n }),
    ).toThrow(/no fee inputs/i);
    expect(() =>
      buildTreasurySweepParts({ accruals: [A], feeInputs: [feeUtxo(0)], changeAddress: '', treasuryKeyHash: KEY_HASH, availableLovelace: 20_000_000n }),
    ).toThrow(/changeAddress/);
  });
});
