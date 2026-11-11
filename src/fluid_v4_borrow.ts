// FluidTokens V4 pools and borrows from them, built as the protocol's validators rebuild them.
//
// pool.ak's mint names a pool NFT after the input it spends; pool_borrow_action.ak rebuilds the
// LoanDatum from the pool datum and the borrow's validity range; loan.ak's mint finds the pool
// withdrawal by its position among the transaction's redeemers; bond.ak names each bond after the
// pool input. Each builder here returns the Plutus Data those checks rebuild, and
// encodePlutusData writes it byte for byte as the reference builders whose vectors the tests
// replay.
//
// The builders lend ADA against ADA at a static ratio. They build the parts of an open-pool or a
// borrow transaction; choosing its inputs, balancing, pricing and signing it is the caller's.
// fluidBorrowGuards makes the checks of a whole borrow that size no output: a validity range of at
// most FLUID_MAX_VALIDITY_MS, a pool lending ADA against ADA at a static ratio, and collateral at
// the pool's minCollateral ratio. The reference builder's last check, a positive principal that
// leaves the pool at or above its min-UTxO, sizes the pool's continuation output, which takes a
// transaction output encoder this SDK does not have; that check stays the caller's.

import { blake2b, blake2b224 } from './blake2b';
import { bytesToHex, encodeConstr, encodeFullAddress } from './cbor';
import { InputError } from './errors';
import { ceilDiv, constrOf, floorDiv } from './fluid_v4';
import type { FluidAsset, FluidLiquidation, Rational } from './fluid_v4';
import { hexToBytesStrict } from './generic_data';
import { decodePlutusData, encodePlutusData } from './plutus_data';
import type { PlutusConstr, PlutusData } from './plutus_data';
import type { PlutusFullAddress } from './types';

/** constants.ak's permissionless condition, "NONE": any borrower may borrow from the pool. */
export const FLUID_NO_PERMISSIONED_CONDITION = '4e4f4e45';
/** constants.ak's no_oracle_token_asset, which a Liquidation pool may not name. */
export const FLUID_NO_ORACLE: Readonly<FluidAsset> = { policyId: '4e4f4e45', assetName: '4e4f4e45' };
/** utils.ak's validity_range_within_an_hour: the widest validity range a borrow may carry. */
export const FLUID_MAX_VALIDITY_MS = 3_600_000n;
export const FLUID_POOL_SPEND_REDEEMER: PlutusConstr = constr(0, []);
/** The datum a lender bond carries, whose hash the pool datum names. */
export const FLUID_LENDER_BOND_DATUM: PlutusConstr = constr(0, []);

/** The terms a pool lends at, ADA against ADA. */
export interface FluidPoolTerms {
  interestRate: bigint;
  /** LiquidationMode.Liquidation's fields. */
  liquidation: FluidLiquidation;
  /** PerpetualLoan's fields. */
  perpetual: { apyIncreaseLinearCoefficient: bigint; maxPossibleRecasts: bigint };
  /** The asset whose oracle prices the collateral; ADA's, ('', ''), prices it at one lovelace. */
  collateralOracle: FluidAsset;
  /** The lovelace locked per lovelace lent: minCollateral / minCollateralDivider. */
  minCollateral: Rational;
}

/**
 * The commonData FluidTokens' own preview pools lend at (2cb300ea's pool), as a perpetual loan
 * with no installments, so it is never late and only liquidation can claim it.
 */
export const FLUID_PREVIEW_ADA_TERMS: Readonly<FluidPoolTerms> = {
  interestRate: 459n,
  liquidation: { ltv: 100n, ltvDivider: 125n, penaltyPerMille: 100n, equityInPrincipalCurrency: false },
  perpetual: { apyIncreaseLinearCoefficient: 28n, maxPossibleRecasts: 5n },
  collateralOracle: { policyId: '', assetName: '' },
  minCollateral: { numerator: 2n, denominator: 1n },
};

/** The parts of PoolBorrowActionWithdrawRedeemer for one pool input. */
export interface FluidBorrowRedeemerParams {
  configIndex: bigint;
  borrower: PlutusFullAddress;
  lenderBondOutput: bigint;
  borrowerBondOutput: bigint;
  principalOracleIndex: bigint;
  collateralIndex: bigint;
  collateralOracleIndex: bigint;
  principal: bigint;
  poolId: string;
  permissionIndex: bigint;
}

/** A redeemer's key: its purpose, spend, mint, cert or withdraw, and its index there. */
export interface FluidRedeemerKey {
  purpose: string;
  index: number;
}

export interface FluidRedeemerUnits extends FluidRedeemerKey {
  mem: bigint;
  steps: bigint;
}

/** The ledger's redeemer tags, the order a script context lists redeemers in. */
const PURPOSE_TAG: ReadonlyMap<string, number> = new Map([
  ['spend', 0],
  ['mint', 1],
  ['cert', 2],
  ['withdraw', 3],
]);
const DECIMAL = /^-?[0-9]+$/;
const POOL_ORIGIN = new Uint8Array([0x50, 0x4f, 0x4f, 0x4c]);

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', message);
}

function constr(index: number, fields: PlutusData[]): PlutusConstr {
  return { constructor: index, fields };
}

function bool(b: boolean): PlutusConstr {
  return constr(b ? 1 : 0, []);
}

function ada(): PlutusConstr {
  return constr(0, [new Uint8Array(), new Uint8Array()]);
}

/** The address as Data: what encodeFullAddress writes, read back. */
function addressData(a: PlutusFullAddress): PlutusConstr {
  return constrOf(decodePlutusData(encodeFullAddress(a)), 'an address');
}

/** An output reference "<tx id>#<index>" as its tx id's bytes and its index. */
function outRefParts(ref: string): [Uint8Array, bigint] {
  const parts = ref.split('#');
  if (parts.length !== 2) refuse(`${ref} is no output reference <tx id>#<index>`);
  const [tx, index] = parts;
  if (!DECIMAL.test(index)) refuse(`${ref} carries no integer output index`);
  return [hexToBytesStrict(tx), BigInt(index)];
}

function outRef(ref: string): PlutusConstr {
  return constr(0, outRefParts(ref));
}

/** blake2b-224 of the reference as serialiseData writes it: utils.ak's hash_output_ref. */
function digestOf(ref: string): string {
  const [tx, index] = outRefParts(ref);
  return bytesToHex(blake2b224(encodeConstr(0, [encodePlutusData(tx), encodePlutusData(index)])));
}

/** The loan NFT's and both bonds' asset name: the hash of the pool input the borrow spends. */
export function fluidLoanId(poolInput: string): string {
  return digestOf(poolInput);
}

/**
 * The name pool.ak lets the `index`-th pool NFT of a mint take: the index byte, then the hash
 * of the input the mint spends.
 */
export function fluidPoolNftName(seed: string, index: number): string {
  if (!(Number.isInteger(index) && index >= 0 && index <= 0xff)) {
    refuse(`a pool NFT name starts with its index as one byte, and ${index} is not one`);
  }
  return index.toString(16).padStart(2, '0') + digestOf(seed);
}

/**
 * A permissionless PoolDatum lending ADA against ADA at `terms`, cancellable by the lender's
 * payment key, its lender bonds paid to the lender's address with FLUID_LENDER_BOND_DATUM.
 */
export function fluidPoolDatum(terms: FluidPoolTerms, opts: { lender: PlutusFullAddress }): PlutusConstr {
  const oracle = [hexToBytesStrict(terms.collateralOracle.policyId), hexToBytesStrict(terms.collateralOracle.assetName)];
  if (bytesToHex(oracle[0]) === FLUID_NO_ORACLE.policyId && bytesToHex(oracle[1]) === FLUID_NO_ORACLE.assetName) {
    refuse(
      "a Liquidation pool's collateral oracle asset may not be NONE/NONE: pool_borrow_action.ak refuses every borrow from it",
    );
  }
  const { ltv, ltvDivider, penaltyPerMille, equityInPrincipalCurrency } = terms.liquidation;
  const { apyIncreaseLinearCoefficient, maxPossibleRecasts } = terms.perpetual;
  const common = constr(0, [
    ada(),
    ada(),
    terms.interestRate,
    0n,
    0n,
    0n,
    constr(2, [ltv, ltvDivider, penaltyPerMille, bool(equityInPrincipalCurrency)]),
    constr(2, [apyIncreaseLinearCoefficient, maxPossibleRecasts]),
    0n,
    0n,
    bool(false),
    new Uint8Array(),
  ]);
  const collateral = constr(0, [new Uint8Array(), constr(0, [new Uint8Array()]), constr(0, oracle)]);
  const { lender } = opts;
  if (lender.payment.kind !== 'key') refuse("a pool is cancelled by its lender's payment key, and a script lender holds none");
  return constr(0, [
    hexToBytesStrict(FLUID_NO_PERMISSIONED_CONDITION),
    constr(0, []),
    common,
    constr(0, [lender.payment.hash.slice()]),
    addressData(lender),
    blake2b(encodePlutusData(FLUID_LENDER_BOND_DATUM), 32),
    [collateral],
    [terms.minCollateral.numerator],
    [terms.minCollateral.denominator],
    bool(false),
  ]);
}

/**
 * The LoanDatum validate_output_to_loan rebuilds from the pool datum `pool`: its commonData, the
 * chosen collateral option, the principal, and the borrow's validity upper bound as lendDate.
 */
export function fluidLoanDatum(
  pool: PlutusData,
  opts: { collateralIndex: number; principal: bigint; validToMs: bigint; poolId: string },
): PlutusConstr {
  const fields = constrOf(pool, 'the pool datum').fields;
  if (fields.length < 3) refuse(`the pool datum has ${fields.length} fields and no commonData`);
  const common = constrOf(fields[2], 'commonData').fields;
  if (common.length !== 12) refuse(`commonData takes 12 fields, got ${common.length}`);
  const [principalAsset, principalOracle, rate, period, installments, grace, liquidation, repayment, window, penalty, receipts] =
    common;
  if (fields.length < 7) refuse(`the pool datum has ${fields.length} fields and no collateral options`);
  const options = fields[6];
  const { collateralIndex } = opts;
  if (!Array.isArray(options) || !(Number.isInteger(collateralIndex) && collateralIndex >= 0 && collateralIndex < options.length)) {
    refuse(`the pool offers no collateral option ${collateralIndex}`);
  }
  const poolId = hexToBytesStrict(opts.poolId);
  const origin = new Uint8Array(POOL_ORIGIN.length + poolId.length);
  origin.set(POOL_ORIGIN);
  origin.set(poolId, POOL_ORIGIN.length);
  return constr(0, [
    0n,
    opts.principal,
    opts.validToMs,
    0n,
    rate,
    installments,
    principalAsset,
    principalOracle,
    period,
    grace,
    liquidation,
    repayment,
    window,
    penalty,
    receipts,
    origin,
    options[collateralIndex],
  ]);
}

export function fluidPoolMintRedeemer(configIndex: bigint, seed: string): PlutusConstr {
  return constr(0, [configIndex, outRef(seed)]);
}

/** The pool policy's withdraw redeemer for a Borrow. */
export function fluidPoolWithdrawRedeemer(configIndex: bigint): PlutusConstr {
  return constr(0, [configIndex, constr(1, [])]);
}

/** The loan mint's redeemer: a loan whose origin is a pool, `origin` the pool withdrawal's position. */
export function fluidLoanMintRedeemer(configIndex: bigint, origin: bigint): PlutusConstr {
  return constr(0, [configIndex, bool(true), origin]);
}

export function fluidBondRedeemer(poolInput: string): PlutusConstr {
  return constr(0, [[outRef(poolInput)]]);
}

/** PoolBorrowActionWithdrawRedeemer for one pool input. */
export function fluidBorrowRedeemer(p: FluidBorrowRedeemerParams): PlutusConstr {
  return constr(0, [
    p.configIndex,
    [
      constr(0, [
        addressData(p.borrower),
        p.lenderBondOutput,
        p.borrowerBondOutput,
        p.principalOracleIndex,
        p.collateralIndex,
        p.collateralOracleIndex,
        p.principal,
        hexToBytesStrict(p.poolId),
        p.permissionIndex,
      ]),
    ],
  ]);
}

function field(fields: PlutusData[], at: number, what: string): PlutusData {
  if (at >= fields.length) refuse(`${what} has ${fields.length} fields and no field ${at}`);
  return fields[at];
}

function sameData(a: PlutusData, b: PlutusData): boolean {
  return bytesToHex(encodePlutusData(a)) === bytesToHex(encodePlutusData(b));
}

function firstInteger(node: PlutusData, what: string): bigint {
  const first = Array.isArray(node) ? node[0] : undefined;
  if (typeof first !== 'bigint') refuse(`${what} is no list that starts with an integer`);
  return first;
}

/**
 * The checks of a borrow from the pool datum `pool` that size no output, in the reference
 * builder's order: a validity range of at most FLUID_MAX_VALIDITY_MS, a pool lending ADA against
 * ADA at a static ratio, and collateral at or above its minCollateral ratio. Returns the lovelace
 * of collateral the pool asks for `principal`.
 */
export function fluidBorrowGuards(
  pool: PlutusData,
  opts: { principal: bigint; collateral: bigint; validFromMs: bigint; validToMs: bigint },
): bigint {
  const width = opts.validToMs - opts.validFromMs;
  if (width > FLUID_MAX_VALIDITY_MS) refuse(`a borrow's validity range must be within an hour; ${width} ms is not`);
  const fields = constrOf(pool, 'the pool datum').fields;
  const common = constrOf(field(fields, 2, 'the pool datum'), 'commonData').fields;
  const options = field(fields, 6, 'the pool datum');
  if (!Array.isArray(options) || options.length === 0) refuse('the pool offers no collateral option');
  const option = constrOf(options[0], 'the collateral option').fields;
  if (
    !sameData(field(common, 0, 'commonData'), ada()) ||
    !sameData(field(option, 0, 'the collateral option'), new Uint8Array()) ||
    !sameData(field(option, 1, 'the collateral option'), constr(0, [new Uint8Array()])) ||
    !sameData(field(fields, 9, 'the pool datum'), bool(false))
  ) {
    refuse('the builder lends only ADA against ADA at a static ratio, and this pool does not');
  }
  const numerator = firstInteger(field(fields, 7, 'the pool datum'), 'minCollateral');
  const denominator = firstInteger(field(fields, 8, 'the pool datum'), 'minCollateralDivider');
  if (denominator === 0n) refuse("the pool's minCollateralDivider is zero");
  const need = ceilDiv(opts.principal * numerator, denominator);
  if (opts.collateral < need) {
    refuse(`the pool asks ${need} lovelace of collateral for ${opts.principal}; ${opts.collateral} is offered`);
  }
  return need;
}

function ledgerTag(purpose: string): number {
  const tag = PURPOSE_TAG.get(purpose);
  if (tag === undefined) refuse(`${purpose} is no redeemer purpose a borrow carries`);
  return tag;
}

/**
 * Where the redeemer at `key` stands in the script context's redeemers, which the ledger orders
 * by purpose tag (spend, mint, cert, withdraw), then index.
 */
export function fluidRedeemerPosition(keys: readonly FluidRedeemerKey[], key: FluidRedeemerKey): number {
  const ordered = keys
    .map((k) => ({ k, tag: ledgerTag(k.purpose) }))
    .sort((a, b) => a.tag - b.tag || a.k.index - b.k.index);
  const at = ordered.findIndex(({ k }) => k.purpose === key.purpose && k.index === key.index);
  if (at < 0) refuse(`no redeemer ${key.purpose} ${key.index} is among the transaction's`);
  return at;
}

/**
 * Each redeemer the view carries at an equal share of the transaction's budget: the units a
 * draft declares before an evaluation reads the scripts' own.
 */
export function fluidDraftUnits(
  view: { redeemers: readonly FluidRedeemerKey[] },
  params: { maxTxMem: bigint; maxTxSteps: bigint },
): FluidRedeemerUnits[] {
  const n = BigInt(view.redeemers.length);
  const seen = new Set<string>();
  const units: FluidRedeemerUnits[] = [];
  for (const { purpose, index } of view.redeemers) {
    const id = `${purpose}#${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    units.push({ purpose, index, mem: floorDiv(params.maxTxMem, n), steps: floorDiv(params.maxTxSteps, n) });
  }
  return units;
}
