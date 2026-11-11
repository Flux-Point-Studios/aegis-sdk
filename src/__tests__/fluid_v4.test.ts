// FluidTokens V4 loans on preview, read as the protocol's validators read them, and the
// RH1 cover a loan asks for. The fixtures are preview's own Koios answers: the suite's
// config UTxO, a borrower's live loan (93492f0e#1, 100 ADA lent against 200 ADA), and
// the five liquidations the suite has run, whose ClaimData carries the remainingDebt the
// loan validator asserted. Synthetic datums cover what preview holds no loan of.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  FLUID_V4_CONFIG_POLICY,
  RH1_MAX_TERM_DAYS,
  ceilDiv,
  coverFluidLoan,
  decodeFluidLoanDatum,
  decodeFluidSuite,
  floorDiv,
  readFluidLoans,
  remainingDebt,
  rh1CoverParams,
} from '../fluid_v4';
import { decodePlutusData } from '../plutus_data';
import { encodeBytes, encodeConstr, encodeInt, hexToBytes } from '../cbor';
import { InputError, InsurabilityError } from '../errors';
import config from './fixtures/preview_suite_config.json';
import loans from './fixtures/preview_borrower_loans.json';
import liquidations from './fixtures/preview_liquidation_debts.json';

const BORROWER =
  'addr_test1qr0prpt3anm70ey4dam4yp2v7jm6g8wsrzwe8vkvr279plkjlqjza7zcf2gs6ymzgdwck9at45ntyrva68jhrfjpym0q6k0yqq';
const LOAN_REF = '93492f0ed239f3d3da55e095defdd347d5ee2d69d53edadeff1aeb7502b9b6eb#1';
const LOAN_ID = '17a5d13b074d7bbd4c0003563ade227760325ca836e7b80839c9bab2';
const LEND_DATE_MS = 1794355013000n;
const DAY_MS = 86_400_000n;
// 2cb300ea#1: FluidTokens' own preview borrow of 20 ADA against tFLDT priced by its oracle.
const TFLDT_LOAN_DATUM =
  'd8799f001a01312d001b000001a09a024090001901cb00d8799f4040ffd8799f4040ff0000d87b9f1864187d1864d87980ffd87b9f181c05ff0000d879805821504f4f4c00507a512704319e88ed15734b152d3759ef3a5069f1e9aca1e0a99ca8d8799f581c0b77d150c275bd0a600633e4be7d09f83c4b9f00981e22ac9c9d3f62d8799f490014df1074464c4454ffd8799f581c9a2ec5c92daccbb269611a9eae7a40f9788d3f9c0229661b6234286f49000de1406f766f3633ffffff';

function koios(answers: Record<string, unknown>) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const path = url.slice(url.lastIndexOf('/') + 1);
    const payload = answers[path];
    return { ok: payload !== undefined, status: payload !== undefined ? 200 : 404, json: async () => payload };
  };
  return { fetchImpl, calls };
}

const LIVE = {
  asset_utxos: config.response,
  address_utxos: loans.response,
  utxo_info: loans.response,
};

function loanDatum(overrides: { repayment?: Uint8Array; period?: bigint; liquidation?: Uint8Array; principal?: Uint8Array; fields?: number } = {}): Uint8Array {
  const ada = encodeConstr(0, [encodeBytes(new Uint8Array()), encodeBytes(new Uint8Array())]);
  const fields = [
    encodeInt(0n), encodeInt(100_000_000n), encodeInt(LEND_DATE_MS), encodeInt(0n), encodeInt(459n), encodeInt(0n),
    overrides.principal ?? ada, ada, encodeInt(overrides.period ?? 0n), encodeInt(0n),
    overrides.liquidation ?? encodeConstr(2, [encodeInt(100n), encodeInt(125n), encodeInt(100n), encodeConstr(0, [])]),
    overrides.repayment ?? encodeConstr(2, [encodeInt(28n), encodeInt(5n)]),
    encodeInt(0n), encodeInt(0n), encodeConstr(0, []), encodeBytes(hexToBytes('504f4f4c00')),
    encodeConstr(0, [encodeBytes(new Uint8Array()), encodeConstr(1, []), ada]),
  ];
  return encodeConstr(0, fields.slice(0, overrides.fields ?? fields.length));
}

describe('decodePlutusData', () => {
  it('reads the indefinite-length config datum as a 29-field constructor', () => {
    const data = decodePlutusData(config.response[0].inline_datum.bytes) as any;
    expect(data.constructor).toBe(0);
    expect(data.fields).toHaveLength(29);
  });

  it('reads a bignum, a chunked bytestring and a map', () => {
    expect(decodePlutusData('c249010000000000000000')).toBe(2n ** 64n);
    expect(decodePlutusData('c349010000000000000000')).toBe(-(2n ** 64n) - 1n);
    expect(decodePlutusData('5f4201024103ff')).toEqual(new Uint8Array([1, 2, 3]));
    expect(decodePlutusData('a10102')).toEqual({ map: [[1n, 2n]] });
  });

  it('refuses trailing bytes and a tag that is no Plutus data', () => {
    expect(() => decodePlutusData('0101')).toThrow(InputError);
    expect(() => decodePlutusData('d90100820102')).toThrow(InputError);
  });
});

describe('decodeFluidSuite', () => {
  it("names the preview suite's loan policy and loan script from its 29-field config", () => {
    const row = config.response[0];
    const suite = decodeFluidSuite(row.inline_datum.bytes, 'preview', `${row.tx_hash}#${row.tx_index}`);
    expect(suite).toEqual({
      network: 'preview',
      configRef: '8dd38e97b79cc7c8a3c59400944b7cd9f724876a1d49ea17ffb5e49b3785091c#0',
      loanPolicyId: '2f1aa941f437e351e3870f7247d735b2bc2952f1c7977426e8960d17',
      loanSpendScriptHash: '31e0dc1d75076e4f7795b24c4cc4b5515791bb4eff4af7961e404f3e',
    });
  });

  it('refuses a config of another arity', () => {
    expect(() => decodeFluidSuite(encodeConstr(0, [encodeInt(1n)]), 'preview', 'x#0')).toThrow(/29/);
  });
});

describe('decodeFluidLoanDatum', () => {
  it('reads the live preview loan: 100 ADA perpetual, liquidated past 100/125, against ADA', () => {
    const d = decodeFluidLoanDatum(loans.response[0].inline_datum.bytes);
    expect(d.principalAmount).toBe(100_000_000n);
    expect(d.principalAsset).toEqual({ policyId: '', assetName: '' });
    expect(d.lendDateMs).toBe(LEND_DATE_MS);
    expect(d.interestRate).toBe(459n);
    expect(d.repayment).toEqual({ mode: 'perpetual', apyIncreaseLinearCoefficient: 28n, maxPossibleRecasts: 5n });
    expect(d.installmentPeriodHours).toBe(0n);
    expect(d.liquidation).toEqual({ ltv: 100n, ltvDivider: 125n, penaltyPerMille: 100n, equityInPrincipalCurrency: false });
    expect(d.collateral).toEqual({ policyId: '', assetName: '', oraclePolicyId: '', oracleAssetName: '' });
    expect(d.originId).toBe('504f4f4c0073e01cdff35b70de7df76006bc296949a3cbfcbb79919d9c537bc239');
  });

  it("reads FluidTokens' own tFLDT loan with its collateral and oracle", () => {
    const d = decodeFluidLoanDatum(TFLDT_LOAN_DATUM);
    expect(d.principalAmount).toBe(20_000_000n);
    expect(d.collateral).toEqual({
      policyId: '0b77d150c275bd0a600633e4be7d09f83c4b9f00981e22ac9c9d3f62',
      assetName: '0014df1074464c4454',
      oraclePolicyId: '9a2ec5c92daccbb269611a9eae7a40f9788d3f9c0229661b6234286f',
      oracleAssetName: '000de1406f766f3633',
    });
  });

  it('reads maybeAssetName None as every name under the policy, and the claim-only modes as no line', () => {
    const d = decodeFluidLoanDatum(loanDatum({ liquidation: encodeConstr(0, []) }));
    expect(d.collateral.assetName).toBeNull();
    expect(d.liquidation).toBeNull();
    expect(decodeFluidLoanDatum(loanDatum({ repayment: encodeConstr(1, []) })).repayment).toEqual({
      mode: 'principal_and_interest_on_installments',
    });
  });

  it('refuses a datum of another arity', () => {
    expect(() => decodeFluidLoanDatum(loanDatum({ fields: 16 }))).toThrow(/17/);
  });
});

describe('remainingDebt', () => {
  it.each(liquidations.liquidations.map((l) => [l.liquidation_tx.slice(0, 12), l] as const))(
    'reproduces the remainingDebt the loan validator asserted in liquidation %s',
    (_name, l) => {
      expect(remainingDebt(decodeFluidLoanDatum(l.loan_datum), BigInt(l.valid_from_ms))).toBe(BigInt(l.remaining_debt));
    },
  );

  it('runs the perpetual APY over the live loan: principal at lendDate, then mx + c', () => {
    const d = decodeFluidLoanDatum(loans.response[0].inline_datum.bytes);
    expect(remainingDebt(d, LEND_DATE_MS)).toBe(100_000_000n);
    expect(remainingDebt(d, LEND_DATE_MS + 3_600_000n)).toBe(100_000_525n);
    expect(remainingDebt(d, LEND_DATE_MS + 30n * DAY_MS)).toBe(100_542_959n);
    expect(remainingDebt(d, LEND_DATE_MS - 1_655_000n)).toBe(99_999_760n);
  });

  it('refuses the installment modes, which no preview loan has run', () => {
    expect(() => remainingDebt(decodeFluidLoanDatum(loanDatum({ repayment: encodeConstr(1, []) })), LEND_DATE_MS)).toThrow(
      InputError,
    );
  });
});

describe('floorDiv and ceilDiv', () => {
  it('round toward negative and positive infinity, for a divisor of either sign', () => {
    const divisor = fc.oneof(fc.bigInt({ min: -(2n ** 70n), max: -1n }), fc.bigInt({ min: 1n, max: 2n ** 70n }));
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), divisor, (n, d) => {
        const floor = floorDiv(n, d);
        const rest = n - floor * d;
        expect(d > 0n ? rest >= 0n && rest < d : rest <= 0n && rest > d).toBe(true);
        expect(ceilDiv(n, d)).toBe(rest === 0n ? floor : floor + 1n);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('readFluidLoans', () => {
  it("finds the borrower's live loan under the suite's loan script and its stake key", async () => {
    const { fetchImpl, calls } = koios(LIVE);
    const found = await readFluidLoans(BORROWER, { network: 'preview', fetchImpl });
    expect(found).toHaveLength(1);
    expect(found[0].ref).toBe(LOAN_REF);
    expect(found[0].loanId).toBe(LOAN_ID);
    expect(found[0].collateralQuantity).toBe(200_000_000n);
    expect(calls[0].url).toBe('https://preview.koios.rest/api/v1/asset_utxos');
    expect(calls[0].body).toEqual({ _asset_list: [[FLUID_V4_CONFIG_POLICY.preview, '706172616d6574657273']], _extended: true });
    expect(calls[1].body).toEqual({ _addresses: [loans.response[0].address], _extended: true });
  });

  it('refuses a network with no pinned suite, and a config not at its own policy', async () => {
    await expect(readFluidLoans(BORROWER, { network: 'preprod', fetchImpl: koios(LIVE).fetchImpl })).rejects.toThrow(InputError);
    const moved = [{ ...config.response[0], payment_cred: '00'.repeat(28) }];
    await expect(
      readFluidLoans(BORROWER, { network: 'preview', fetchImpl: koios({ ...LIVE, asset_utxos: moved }).fetchImpl }),
    ).rejects.toThrow(/own script address/);
  });

  it('skips an output holding no loan token and refuses one whose loan token sits in no loan datum', async () => {
    const stray = { ...loans.response[0], tx_index: 7, asset_list: [] };
    const broken = { ...loans.response[0], tx_index: 8, inline_datum: { bytes: 'd87980', value: {} } };
    const { fetchImpl } = koios({ ...LIVE, address_utxos: [stray, ...loans.response] });
    expect(await readFluidLoans(BORROWER, { network: 'preview', fetchImpl })).toHaveLength(1);
    await expect(
      readFluidLoans(BORROWER, { network: 'preview', fetchImpl: koios({ ...LIVE, address_utxos: [broken] }).fetchImpl }),
    ).rejects.toThrow(InputError);
  });
});

describe('rh1CoverParams', () => {
  const loan = {
    ref: LOAN_REF,
    loanId: LOAN_ID,
    lovelace: 200_000_000n,
    collateralQuantity: 200_000_000n,
    datum: decodeFluidLoanDatum(loans.response[0].inline_datum.bytes),
  };

  it("covers the loan's debt at the cover's start, for the term asked, triggered by its liquidation line", () => {
    const start = LEND_DATE_MS + 3_600_000n;
    const p = rh1CoverParams(loan, { startMs: start, termDays: 30 });
    expect(p.coverageLovelace).toBe(100_000_525n);
    expect(p.startMs).toBe(start);
    expect(p.expiryMs).toBe(start + 30n * DAY_MS);
    expect(p.trigger).toEqual({
      event: 'liquidation',
      loanRef: LOAN_REF,
      loanId: LOAN_ID,
      liquidationLtv: { numerator: 100n, denominator: 125n },
      penaltyPerMille: 100n,
      distanceBps: 3749,
      lineLossLovelace: 10_000_052n,
    });
  });

  it("never covers less than the principal: before lendDate the protocol's formula runs backwards", () => {
    expect(rh1CoverParams(loan, { startMs: LEND_DATE_MS - 1_655_000n, termDays: 1 }).coverageLovelace).toBe(100_000_000n);
  });

  it('prices token collateral only at a price it is given', () => {
    const tfldt = { ...loan, datum: decodeFluidLoanDatum(TFLDT_LOAN_DATUM), collateralQuantity: 4_000n };
    expect(rh1CoverParams(tfldt, { startMs: 1789290234000n, termDays: 1 }).trigger.distanceBps).toBeNull();
    const priced = rh1CoverParams(tfldt, {
      startMs: 1789290234000n,
      termDays: 1,
      collateralLovelacePerUnit: { numerator: 10_000n, denominator: 1n },
    });
    expect(priced.trigger.distanceBps).toBe(3750);
  });

  it('refuses a term outside an event policy\'s one day to the book\'s longest', () => {
    expect(() => rh1CoverParams(loan, { startMs: LEND_DATE_MS, termDays: 0 })).toThrow(InputError);
    expect(() => rh1CoverParams(loan, { startMs: LEND_DATE_MS, termDays: RH1_MAX_TERM_DAYS + 1 })).toThrow(InputError);
  });

  it('refuses a loan RH1 cannot cover: late-claimable, debt not in ADA, or no liquidation line', () => {
    const variants = [
      loanDatum({ period: 24n }),
      loanDatum({ repayment: encodeConstr(1, []) }),
      loanDatum({ principal: encodeConstr(0, [encodeBytes(hexToBytes('00'.repeat(28))), encodeBytes(new Uint8Array())]) }),
      loanDatum({ liquidation: encodeConstr(0, []) }),
    ];
    for (const raw of variants) {
      expect(() => rh1CoverParams({ ...loan, datum: decodeFluidLoanDatum(raw) }, { startMs: LEND_DATE_MS, termDays: 1 })).toThrow(
        InsurabilityError,
      );
    }
  });
});

describe('coverFluidLoan', () => {
  it('reads the loan by its ref and returns the RH1 cover request wave 2 sells', async () => {
    const { fetchImpl, calls } = koios(LIVE);
    const req = await coverFluidLoan(LOAN_REF, { network: 'preview', fetchImpl, startMs: LEND_DATE_MS, termDays: 7 });
    expect(calls.map((c) => c.url.slice(c.url.lastIndexOf('/') + 1))).toEqual(['asset_utxos', 'utxo_info']);
    expect(calls[1].body).toEqual({ _utxo_refs: [LOAN_REF], _extended: true });
    expect(req).toEqual({
      network: 'preview',
      row: 'RH1',
      settlement: 'lovelace',
      suite: {
        configRef: '8dd38e97b79cc7c8a3c59400944b7cd9f724876a1d49ea17ffb5e49b3785091c#0',
        loanPolicyId: '2f1aa941f437e351e3870f7247d735b2bc2952f1c7977426e8960d17',
        loanSpendScriptHash: '31e0dc1d75076e4f7795b24c4cc4b5515791bb4eff4af7961e404f3e',
      },
      loan: {
        ref: LOAN_REF,
        loanId: LOAN_ID,
        lendDateMs: LEND_DATE_MS,
        principalLovelace: 100_000_000n,
        collateral: { policyId: '', assetName: '', quantity: 200_000_000n },
      },
      coverageLovelace: 100_000_000n,
      startMs: LEND_DATE_MS,
      expiryMs: LEND_DATE_MS + 7n * DAY_MS,
      trigger: {
        event: 'liquidation',
        loanRef: LOAN_REF,
        loanId: LOAN_ID,
        liquidationLtv: { numerator: 100n, denominator: 125n },
        penaltyPerMille: 100n,
        distanceBps: 3750,
        lineLossLovelace: 10_000_000n,
      },
    });
  });

  it('refuses a ref that holds no loan of the suite', async () => {
    const elsewhere = [{ ...loans.response[0], payment_cred: '00'.repeat(28) }];
    await expect(
      coverFluidLoan(LOAN_REF, { network: 'preview', fetchImpl: koios({ ...LIVE, utxo_info: elsewhere }).fetchImpl, termDays: 1 }),
    ).rejects.toThrow(/loan script/);
    const spent = [{ ...loans.response[0], is_spent: true }];
    await expect(
      coverFluidLoan(LOAN_REF, { network: 'preview', fetchImpl: koios({ ...LIVE, utxo_info: spent }).fetchImpl, termDays: 1 }),
    ).rejects.toThrow(/spent/);
  });
});
