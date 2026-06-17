// decodeChainError — turns cryptic wallet/node/submit failures into a stable
// code + plain-English title + actionable hint. The test inputs are REAL
// Cardano ledger error tags + CIP-30 shapes (incl. the exact phase-2 reject
// the preprod proof hit).

import { describe, it, expect } from 'vitest';
import { decodeChainError } from '../decode';

const cases: Array<[string, unknown, string]> = [
  [
    'SCRIPT_FAILED',
    'ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure ...)))))',
    'validator',
  ],
  ['SCRIPT_FAILED', 'ScriptExecutionError: the machine terminated', 'validator'],
  ['SCRIPT_DATA_HASH_MISMATCH', 'PPViewHashesDontMatch (...)', 'script-data'],
  ['VALUE_NOT_CONSERVED', 'ValueNotConservedUTxO (...) consumed != produced', 'conserv'],
  ['OUTSIDE_VALIDITY', 'OutsideValidityIntervalUTxO (ValidityInterval ...) (SlotNo 12345)', 'validity'],
  ['INPUTS_SPENT', 'BadInputsUTxO (TxIn ...)', 'spent'],
  ['COLLATERAL_INSUFFICIENT', 'InsufficientCollateral (DeltaCoin ...)', 'collateral'],
  ['MISSING_SIGNATURE', 'MissingVKeyWitnessesUTXOW (...)', 'sign'],
  ['EX_UNITS_TOO_BIG', 'ExUnitsTooBigUTxO (ExUnits ...) exceeds the max', 'budget'],
  ['FEE_TOO_SMALL', 'FeeTooSmallUTxO (Coin 180000) (Coin 200000)', 'fee'],
  ['MIN_UTXO', 'BabbageOutputTooSmallUTxO (...)', 'min'],
];

describe('decodeChainError — ledger error tags', () => {
  for (const [code, raw, hintNeedle] of cases) {
    it(`maps "${(raw as string).slice(0, 28)}…" → ${code}`, () => {
      const d = decodeChainError(raw);
      expect(d.code).toBe(code);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(0);
      // the decoded message (title + hint) references the concept
      expect(`${d.title} ${d.hint}`.toLowerCase()).toContain(hintNeedle);
      expect(d.raw.length).toBeGreaterThan(0);
    });
  }
});

describe('decodeChainError — CIP-30 wallet shapes', () => {
  it('decodes a user-declined sign (CIP-30 code 2 / "declined")', () => {
    expect(decodeChainError({ code: 2, info: 'user declined to sign' }).code).toBe('USER_DECLINED');
    expect(decodeChainError('user declined tx').code).toBe('USER_DECLINED');
  });

  it('decodes a wallet internal/invalid error', () => {
    expect(decodeChainError({ code: -2, info: 'InternalError' }).code).toBe('WALLET_INTERNAL');
  });

  it('decodes an Error object (reads .message)', () => {
    expect(decodeChainError(new Error('PPViewHashesDontMatch')).code).toBe('SCRIPT_DATA_HASH_MISMATCH');
  });

  it('falls back to UNKNOWN with the raw preserved', () => {
    const d = decodeChainError('some brand new ledger tag nobody has seen');
    expect(d.code).toBe('UNKNOWN');
    expect(d.raw).toContain('brand new');
    expect(d.hint.length).toBeGreaterThan(0);
  });
});
