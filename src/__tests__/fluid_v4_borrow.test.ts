// The FluidTokens V4 pool and borrow builders, replayed from the vectors the Python builders they
// port wrote: every row's arguments in, the same bytes, name, position or units out, or the same
// refusal. The recorded rows also answer to the preview transaction they rebuild: the bytes or
// redeemer hash of the pool and borrow these builders landed (6ca799bb, 93492f0e), and the Data
// of FluidTokens' own borrow and pool open (2cb300ea, f25e1378). The properties hold the datums
// to decoders written apart from the builders.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  FLUID_LENDER_BOND_DATUM,
  FLUID_MAX_VALIDITY_MS,
  FLUID_NO_ORACLE,
  FLUID_NO_PERMISSIONED_CONDITION,
  FLUID_POOL_SPEND_REDEEMER,
  FLUID_PREVIEW_ADA_TERMS,
  fluidBondRedeemer,
  fluidBorrowRedeemer,
  fluidDraftUnits,
  fluidLoanDatum,
  fluidLoanId,
  fluidLoanMintRedeemer,
  fluidPoolDatum,
  fluidPoolMintRedeemer,
  fluidPoolNftName,
  fluidPoolWithdrawRedeemer,
  fluidRedeemerPosition,
} from '../fluid_v4_borrow';
import type { FluidPoolTerms, FluidRedeemerKey, FluidRedeemerUnits } from '../fluid_v4_borrow';
import { decodeFluidLoanDatum } from '../fluid_v4';
import type { FluidLoanDatum } from '../fluid_v4';
import { decodePlutusData, encodePlutusData } from '../plutus_data';
import type { PlutusConstr, PlutusData } from '../plutus_data';
import { blake2b, blake2b224 } from '../blake2b';
import { bytesToHex, hexToBytes } from '../cbor';
import { InputError } from '../errors';
import type { PlutusCredential, PlutusFullAddress } from '../types';
import * as port from '../fluid_v4_borrow';
import * as entry from '../index';
import vectorsJson from './fixtures/fluid_v4_borrow_vectors.json';

// A JSON module's type gives each row the keys other rows hold as `?: undefined`.
type Json = string | boolean | null | Json[] | { [key: string]: Json | undefined };
type Args = { [key: string]: Json | undefined };

interface Row {
  name: string;
  args: Args;
  out?: Json;
  raises?: { type: string; message: string; module: boolean };
  tx?: string;
  onChain?: Args;
}

interface Vectors {
  source: string;
  generator: string;
  generatedFrom: string;
  assemblers: string[];
  types: { [name: string]: string[] };
  constants: Args;
  functions: { [name: string]: Row[] };
}

const vectors: Vectors = vectorsJson;

function str(j: Json | undefined): string {
  if (typeof j !== 'string') throw new Error(`vector field ${JSON.stringify(j)} is no string`);
  return j;
}

function big(j: Json | undefined): bigint {
  return BigInt(str(j));
}

function num(j: Json | undefined): number {
  return Number(str(j));
}

function obj(j: Json | undefined): Args {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error(`vector field ${JSON.stringify(j)} is no object`);
  return j;
}

function arr(j: Json | undefined): Json[] {
  if (!Array.isArray(j)) throw new Error(`vector field ${JSON.stringify(j)} is no list`);
  return j;
}

function credential(j: Json | undefined): PlutusCredential {
  const c = obj(j);
  return 'key' in c ? { kind: 'key', hash: hexToBytes(str(c.key)) } : { kind: 'script', hash: hexToBytes(str(c.script)) };
}

function address(j: Json | undefined): PlutusFullAddress {
  const a = obj(j);
  return { payment: credential(a.payment), stake: a.stake === null ? null : credential(a.stake) };
}

function terms(j: Json | undefined): FluidPoolTerms {
  const t = obj(j);
  const [ltv, ltvDivider, penaltyPerMille, equity] = arr(t.liquidation);
  const [apyIncreaseLinearCoefficient, maxPossibleRecasts] = arr(t.perpetual).map(big);
  const [policyId, assetName] = arr(t.collateral_oracle).map(str);
  const [numerator, denominator] = arr(t.min_collateral).map(big);
  return {
    interestRate: big(t.interest_rate),
    liquidation: { ltv: big(ltv), ltvDivider: big(ltvDivider), penaltyPerMille: big(penaltyPerMille), equityInPrincipalCurrency: equity === true },
    perpetual: { apyIncreaseLinearCoefficient, maxPossibleRecasts },
    collateralOracle: { policyId, assetName },
    minCollateral: { numerator, denominator },
  };
}

function termsWire(t: FluidPoolTerms): Json {
  const l = t.liquidation;
  return {
    interest_rate: String(t.interestRate),
    liquidation: [String(l.ltv), String(l.ltvDivider), String(l.penaltyPerMille), l.equityInPrincipalCurrency],
    perpetual: [String(t.perpetual.apyIncreaseLinearCoefficient), String(t.perpetual.maxPossibleRecasts)],
    collateral_oracle: [t.collateralOracle.policyId, t.collateralOracle.assetName],
    min_collateral: [String(t.minCollateral.numerator), String(t.minCollateral.denominator)],
  };
}

function key(j: Json | undefined): FluidRedeemerKey {
  const k = obj(j);
  return { purpose: str(k.purpose), index: num(k.index) };
}

type Built = PlutusConstr | string | number | FluidRedeemerUnits[];

/** Each Python function of the vectors, called through its port. */
const REPLAYS: { [fn: string]: (a: Args) => Built } = {
  loan_id: (a) => fluidLoanId(str(a.pool_input)),
  pool_nft_name: (a) => fluidPoolNftName(str(a.seed), num(a.index)),
  pool_datum: (a) => fluidPoolDatum(terms(a.terms), { lender: address(a.lender) }),
  loan_datum: (a) =>
    fluidLoanDatum(decodePlutusData(str(a.pool)), {
      collateralIndex: num(a.collateral_index),
      principal: big(a.principal),
      validToMs: big(a.valid_to_ms),
      poolId: str(a.pool_id),
    }),
  pool_mint_redeemer: (a) => fluidPoolMintRedeemer(big(a.config_index), str(a.seed)),
  pool_withdraw_redeemer: (a) => fluidPoolWithdrawRedeemer(big(a.config_index)),
  loan_mint_redeemer: (a) => fluidLoanMintRedeemer(big(a.config_index), big(a.origin)),
  bond_redeemer: (a) => fluidBondRedeemer(str(a.pool_input)),
  borrow_redeemer: (a) =>
    fluidBorrowRedeemer({
      configIndex: big(a.config_index),
      borrower: address(a.borrower),
      lenderBondOutput: big(a.lender_bond_output),
      borrowerBondOutput: big(a.borrower_bond_output),
      principalOracleIndex: big(a.principal_oracle_index),
      collateralIndex: big(a.collateral_index),
      collateralOracleIndex: big(a.collateral_oracle_index),
      principal: big(a.principal),
      poolId: str(a.pool_id),
      permissionIndex: big(a.permission_index),
    }),
  redeemer_position: (a) => fluidRedeemerPosition(arr(a.keys).map(key), key(a.key)),
  draft_units: (a) =>
    fluidDraftUnits(
      { redeemers: arr(obj(a.view).redeemers).map(key) },
      { maxTxMem: big(obj(a.params).max_tx_mem), maxTxSteps: big(obj(a.params).max_tx_steps) },
    ),
};

function wire(built: Built): Json {
  if (typeof built === 'string') return built;
  if (typeof built === 'number') return String(built);
  if (Array.isArray(built)) {
    return built.map((u) => ({ purpose: u.purpose, index: String(u.index), mem: String(u.mem), steps: String(u.steps) }));
  }
  return bytesToHex(encodePlutusData(built));
}

function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('the port built what the authority refused');
}

/** A Koios rendering of Plutus Data, its integers written as strings, as Data. */
function koiosData(j: Json | undefined): PlutusData {
  const node = new Map(Object.entries(obj(j)));
  if (node.has('constructor')) return { constructor: num(node.get('constructor')), fields: arr(node.get('fields')).map(koiosData) };
  if (node.has('int')) return big(node.get('int'));
  if (node.has('bytes')) return hexToBytes(str(node.get('bytes')));
  if (node.has('list')) return arr(node.get('list')).map(koiosData);
  return { map: arr(node.get('map')).map((e): [PlutusData, PlutusData] => [koiosData(obj(e).k), koiosData(obj(e).v)]) };
}

const rows = Object.entries(vectors.functions).flatMap(([fn, list]) => list.map((row): [string, Row] => [fn, row]));

describe('the vectors fluid_v4_borrow.py wrote', () => {
  it('carry the commit they were generated from', () => {
    expect(vectors.generatedFrom).toMatch(/^[0-9a-f]{40}$/);
    expect(vectors.source).toBe('api/lending/fluid_v4_borrow.py');
    expect(vectors.generator).toBe('scripts/fluid_v4_borrow_vectors.py');
  });

  it('name exactly the functions ported here, the two transaction assemblers aside', () => {
    expect(Object.keys(REPLAYS).sort()).toEqual(Object.keys(vectors.functions).sort());
    expect(vectors.assemblers).toEqual(['borrow_view', 'open_pool_view']);
    expect(vectors.types).toEqual({ PoolTerms: Object.keys(obj(termsWire(FLUID_PREVIEW_ADA_TERMS))) });
  });

  it('hold the constants the port declares', () => {
    expect({
      NO_PERMISSIONED_CONDITION: FLUID_NO_PERMISSIONED_CONDITION,
      NO_ORACLE: [FLUID_NO_ORACLE.policyId, FLUID_NO_ORACLE.assetName],
      MAX_VALIDITY_MS: String(FLUID_MAX_VALIDITY_MS),
      POOL_SPEND_REDEEMER: wire(FLUID_POOL_SPEND_REDEEMER),
      LENDER_BOND_DATUM: wire(FLUID_LENDER_BOND_DATUM),
      PREVIEW_ADA_TERMS: termsWire(FLUID_PREVIEW_ADA_TERMS),
    }).toEqual(vectors.constants);
  });

  it('rebuild all four recorded preview transactions', () => {
    expect(new Set(rows.flatMap(([, row]) => (row.tx === undefined ? [] : [row.tx])))).toEqual(
      new Set([
        '2cb300eaef3e83011b7c8c433d092a5d674d748f6c53e1be048e35a96dad1760',
        'f25e1378b4387324e29264398bcac85711c9f3057ae7a989414333e944978828',
        '6ca799bb84b7d8a07255fce9ab80326cba7b1938bd0c3185f0b2c584f6479e64',
        '93492f0ed239f3d3da55e095defdd347d5ee2d69d53edadeff1aeb7502b9b6eb',
      ]),
    );
  });
});

describe('the package entry', () => {
  it('exports every builder and constant of the port, and the encoder', () => {
    const exported = new Map(Object.entries(entry));
    expect(Object.keys(port).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(port)) expect(exported.get(name), name).toBe(value);
    expect(exported.get('encodePlutusData')).toBe(encodePlutusData);
  });
});

describe.each(Object.keys(vectors.functions))('%s replays byte for byte', (fn) => {
  it.each(vectors.functions[fn].map((row): [string, Row] => [row.name, row]))('%s', (_name, row) => {
    const replay = REPLAYS[fn];
    if (row.raises !== undefined) {
      const error = thrown(() => replay(row.args));
      expect(error).toBeInstanceOf(InputError);
      if (row.raises.module && error instanceof InputError) expect(error.message).toBe(row.raises.message);
      return;
    }
    expect(wire(replay(row.args))).toEqual(row.out);
  });
});

describe('the recorded rows', () => {
  const recorded = rows.filter(([, row]) => row.tx !== undefined).map(([fn, row]): [string, string, Row] => [`${fn}: ${row.name}`, fn, row]);
  it.each(recorded)('%s', (_title, fn, row) => {
    const built = wire(REPLAYS[fn](row.args));
    const facts = Object.entries(row.onChain ?? {});
    expect(facts).toHaveLength(1);
    const [[kind, fact]] = facts;
    if (kind === 'bytes') expect(built).toBe(fact);
    else if (kind === 'data') {
      expect(built).not.toBe(fact);
      expect(bytesToHex(encodePlutusData(decodePlutusData(str(fact))))).toBe(built);
    } else if (kind === 'redeemerHash') expect(bytesToHex(blake2b(hexToBytes(str(built)), 32))).toBe(fact);
    else if (kind === 'value') expect(decodePlutusData(str(built))).toEqual(koiosData(fact));
    else {
      expect(['assetName', 'position']).toContain(kind);
      expect(built).toBe(fact);
    }
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const hexOf = (min: number, max: number) => fc.uint8Array({ minLength: min, maxLength: max }).map(bytesToHex);
const anyInt = fc.oneof(fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), fc.constantFrom(0n, 2n ** 64n - 1n, 2n ** 64n, -(2n ** 64n) - 1n));
const credentialArb: fc.Arbitrary<PlutusCredential> = fc.record({
  kind: fc.constantFrom<'key' | 'script'>('key', 'script'),
  hash: fc.uint8Array({ minLength: 28, maxLength: 28 }),
});
const lenderArb: fc.Arbitrary<PlutusFullAddress> = fc.record({
  payment: fc.uint8Array({ minLength: 28, maxLength: 28 }).map((hash): PlutusCredential => ({ kind: 'key', hash })),
  stake: fc.option(credentialArb, { nil: null }),
});
const termsArb: fc.Arbitrary<FluidPoolTerms> = fc
  .record({
    interestRate: anyInt,
    liquidation: fc.record({ ltv: anyInt, ltvDivider: anyInt, penaltyPerMille: anyInt, equityInPrincipalCurrency: fc.boolean() }),
    perpetual: fc.record({ apyIncreaseLinearCoefficient: anyInt, maxPossibleRecasts: anyInt }),
    collateralOracle: fc.record({ policyId: hexOf(0, 28), assetName: hexOf(0, 32) }),
    minCollateral: fc.record({ numerator: anyInt, denominator: anyInt }),
  })
  .filter((t) => !(t.collateralOracle.policyId === FLUID_NO_ORACLE.policyId && t.collateralOracle.assetName === FLUID_NO_ORACLE.assetName));
const loanArb = fc.record({ terms: termsArb, lender: lenderArb, principal: anyInt, validToMs: anyInt, poolId: hexOf(0, 32) });

describe('attack_datum_round_trip', () => {
  it('attack_datum_round_trip: the loan datum decodeFluidLoanDatum reads back is the one built, over the full field ranges', () => {
    fc.assert(
      fc.property(loanArb, ({ terms: t, lender, principal, validToMs, poolId }) => {
        const pool = fluidPoolDatum(t, { lender });
        const loan = decodeFluidLoanDatum(encodePlutusData(fluidLoanDatum(pool, { collateralIndex: 0, principal, validToMs, poolId })));
        const ada = { policyId: '', assetName: '' };
        const expected: FluidLoanDatum = {
          doneRecasts: 0n,
          principalAmount: principal,
          lendDateMs: validToMs,
          repaidInstallments: 0n,
          interestRate: t.interestRate,
          totalInstallments: 0n,
          principalAsset: ada,
          principalOracleAsset: ada,
          installmentPeriodHours: 0n,
          initialGracePeriodHours: 0n,
          liquidation: t.liquidation,
          repayment: { mode: 'perpetual', ...t.perpetual },
          repaymentTimeWindowHours: 0n,
          penaltyFeeForLateRepayment: 0n,
          repaymentReceipts: false,
          originId: '504f4f4c' + poolId,
          collateral: { policyId: '', assetName: '', oraclePolicyId: t.collateralOracle.policyId, oracleAssetName: t.collateralOracle.assetName },
        };
        expect(loan).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('attack_datum_round_trip: each datum decodes to what was built and re-encodes to its own bytes, and the lender bond datum hashes to the hash its pool carries', () => {
    fc.assert(
      fc.property(loanArb, ({ terms: t, lender, principal, validToMs, poolId }) => {
        const pool = fluidPoolDatum(t, { lender });
        const loan = fluidLoanDatum(pool, { collateralIndex: 0, principal, validToMs, poolId });
        for (const datum of [pool, loan, FLUID_LENDER_BOND_DATUM]) {
          const bytes = encodePlutusData(datum);
          const back = decodePlutusData(bytes);
          expect(back).toEqual(datum);
          expect(encodePlutusData(back)).toEqual(bytes);
        }
        expect(bytesToHex(encodePlutusData(FLUID_LENDER_BOND_DATUM))).toBe('d87980');
        expect(pool.fields[5]).toEqual(hexToBytes('923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec'));
      }),
      { numRuns: 300 },
    );
  });
});

/** CBOR's head for an unsigned integer, written out here rather than taken from the encoder. */
function uintHead(n: bigint): number[] {
  if (n < 24n) return [Number(n)];
  const width = n < 0x100n ? 1 : n < 0x10000n ? 2 : n < 0x100000000n ? 4 : 8;
  const bytes = Array.from({ length: width }, (_, i) => Number((n >> BigInt(8 * (width - 1 - i))) & 0xffn));
  return [{ 1: 24, 2: 25, 4: 26, 8: 27 }[width] ?? 0, ...bytes];
}

describe('names', () => {
  it('a loan id and a pool NFT name hash the output reference as serialiseData writes it', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.integer({ min: 0, max: 255 }), (tx, index, nth) => {
        const ref = `${bytesToHex(tx)}#${index}`;
        const serialised = new Uint8Array([0xd8, 0x79, 0x9f, 0x58, 0x20, ...tx, ...uintHead(index), 0xff]);
        const digest = bytesToHex(blake2b224(serialised));
        expect(fluidLoanId(ref)).toBe(digest);
        expect(fluidPoolNftName(ref, nth)).toBe(nth.toString(16).padStart(2, '0') + digest);
      }),
      { numRuns: 300 },
    );
  });
});

const purposes = ['spend', 'mint', 'cert', 'withdraw'];
const keyArb: fc.Arbitrary<FluidRedeemerKey> = fc.record({ purpose: fc.constantFrom(...purposes), index: fc.integer({ min: 0, max: 40 }) });

describe('redeemer pointers', () => {
  it("the loan mint's pointer counts the redeemers the ledger orders before it: purpose tag, then index", () => {
    fc.assert(
      fc.property(fc.array(keyArb, { minLength: 1, maxLength: 12 }), fc.nat(), (keys, pick) => {
        const target = keys[pick % keys.length];
        const before = (k: FluidRedeemerKey) =>
          purposes.indexOf(k.purpose) < purposes.indexOf(target.purpose) ||
          (k.purpose === target.purpose && k.index < target.index);
        expect(fluidRedeemerPosition(keys, target)).toBe(keys.filter(before).length);
      }),
      { numRuns: 500 },
    );
  });
});

describe('attack_stale_protocol_params', () => {
  it('attack_stale_protocol_params: draft units come only from the parameters passed, so a fresh set moves every share and none sums past its budget', () => {
    const budget = fc.record({ maxTxMem: fc.bigInt({ min: 1n, max: 2n ** 70n }), maxTxSteps: fc.bigInt({ min: 1n, max: 2n ** 70n }) });
    fc.assert(
      fc.property(fc.array(keyArb, { minLength: 1, maxLength: 12 }), budget, budget, (keys, cached, live) => {
        const n = BigInt(keys.length);
        fluidDraftUnits({ redeemers: keys }, cached);
        const units = fluidDraftUnits({ redeemers: keys }, live);
        expect(units.map((u) => `${u.purpose}#${u.index}`)).toEqual([...new Set(keys.map((k) => `${k.purpose}#${k.index}`))]);
        for (const u of units) {
          expect(u.mem).toBe(live.maxTxMem / n);
          expect(u.steps).toBe(live.maxTxSteps / n);
        }
        expect(units.reduce((s, u) => s + u.mem, 0n)).toBeLessThanOrEqual(live.maxTxMem);
        expect(units.reduce((s, u) => s + u.steps, 0n)).toBeLessThanOrEqual(live.maxTxSteps);
        expect(new Set(units.map((u) => `${u.purpose}#${u.index}`)).size).toBe(units.length);
      }),
      { numRuns: 300 },
    );
  });
});
