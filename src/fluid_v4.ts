// FluidTokens V4 loans, read as the protocol's validators read them, and the RH1 cover a
// loan asks the Aegis Book for: cover of the loan's debt, paid in ADA if FluidTokens
// liquidates the loan during the term.
//
// A suite is named by its config token, "parameters" under the pinned config policy, whose
// datum names every validator. A borrower's loans sit at the suite's loan script under the
// borrower's own stake credential, each holding the one loan-policy token named by its
// loan id. The debt mirrors finance.ak's get_remaining_debt for perpetual loans.

import { bech32Address, decodeBech32Address } from './address';
import type { Network } from './address';
import { bytesToHex, hexToBytes } from './cbor';
import { InputError, InsurabilityError } from './errors';
import { CHAIN_FACTS } from './networks';
import { koiosUtxos } from './koios';
import type { KoiosAsset, KoiosReadOptions, KoiosUtxo } from './koios';
import { constrOf, dataHex as hex, dataInt as int, decodePlutusData, fieldsOf } from './plutus_data';
import type { PlutusConstr, PlutusData } from './plutus_data';

/** The config policy of each network's FluidTokens V4 suite this SDK reads. */
export const FLUID_V4_CONFIG_POLICY: Readonly<Partial<Record<Network, string>>> = {
  preview: 'd46f626fc11750409cf44f3d202f48d1b5df41ad35d62a7364b8e22e',
};
const CONFIG_ASSET_NAME = '706172616d6574657273';
const CONFIG_FIELDS = 29;
const LOAN_FIELDS = 17;
/** An event policy runs at least a day: a liquidation confirms well after it lands. */
export const RH1_MIN_TERM_DAYS = 1;
/** The longest policy term the Book sells. */
export const RH1_MAX_TERM_DAYS = 180;
const DAY_MS = 86_400_000n;
const HOUR_MS = 3_600_000n;

export interface FluidV4Suite {
  network: Network;
  configRef: string;
  loanPolicyId: string;
  loanSpendScriptHash: string;
  poolPolicyId: string;
  poolSpendScriptHash: string;
  poolBorrowActionScriptHash: string;
  borrowerBondPolicyId: string;
  lenderBondPolicyId: string;
}

export interface FluidAsset {
  policyId: string;
  assetName: string;
}

/** `assetName` null is maybeAssetName None: every asset name under the policy is collateral. */
export interface FluidCollateral {
  policyId: string;
  assetName: string | null;
  oraclePolicyId: string;
  oracleAssetName: string;
}

export interface FluidLiquidation {
  ltv: bigint;
  ltvDivider: bigint;
  penaltyPerMille: bigint;
  equityInPrincipalCurrency: boolean;
}

export type FluidRepayment =
  | { mode: 'interest_on_remaining_principal'; maxPossibleRecasts: bigint }
  | { mode: 'principal_and_interest_on_installments' }
  | { mode: 'perpetual'; apyIncreaseLinearCoefficient: bigint; maxPossibleRecasts: bigint };

/** types/loan.ak's LoanDatum. `liquidation` is null for the two claim-only modes. */
export interface FluidLoanDatum {
  doneRecasts: bigint;
  principalAmount: bigint;
  lendDateMs: bigint;
  repaidInstallments: bigint;
  interestRate: bigint;
  totalInstallments: bigint;
  principalAsset: FluidAsset;
  principalOracleAsset: FluidAsset;
  installmentPeriodHours: bigint;
  initialGracePeriodHours: bigint;
  liquidation: FluidLiquidation | null;
  repayment: FluidRepayment;
  repaymentTimeWindowHours: bigint;
  penaltyFeeForLateRepayment: bigint;
  repaymentReceipts: boolean;
  originId: string;
  collateral: FluidCollateral;
}

export interface FluidLoan {
  ref: string;
  loanId: string;
  lovelace: bigint;
  /** The collateral the UTxO's own value holds: all its lovelace for an ADA collateral. */
  collateralQuantity: bigint;
  datum: FluidLoanDatum;
}

export type FluidReadOptions = KoiosReadOptions;

export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export interface Rh1CoverOptions {
  startMs: bigint;
  termDays: number;
  /** Lovelace per unit of a token collateral; ADA collateral needs none. */
  collateralLovelacePerUnit?: Rational;
}

export interface Rh1Trigger {
  event: 'liquidation';
  loanRef: string;
  loanId: string;
  liquidationLtv: Rational;
  penaltyPerMille: bigint;
  /** How far the loan stands from its line at the start; null for a token collateral given no price. */
  distanceBps: number | null;
  /** What a liquidation at the line costs the borrower: the most a slot on this loan is sized for. */
  lineLossLovelace: bigint;
}

export interface Rh1CoverParams {
  coverageLovelace: bigint;
  startMs: bigint;
  expiryMs: bigint;
  trigger: Rh1Trigger;
}

/** What a gen-3 Book sale on the RH1 row is built from, paid in lovelace by the ADA instance. */
export interface FluidCoverRequest extends Rh1CoverParams {
  network: Network;
  row: 'RH1';
  settlement: 'lovelace';
  suite: Omit<FluidV4Suite, 'network'>;
  loan: {
    ref: string;
    loanId: string;
    lendDateMs: bigint;
    principalLovelace: bigint;
    collateral: { policyId: string; assetName: string | null; quantity: bigint };
  };
}

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', message);
}

function bool(node: PlutusData, what: string): boolean {
  const c = constrOf(node, what);
  if (c.fields.length !== 0 || c.constructor > 1) refuse(`${what} is no Bool`);
  return c.constructor === 1;
}

function asset(node: PlutusData, what: string): FluidAsset {
  const f = fieldsOf(node, what, 2);
  return { policyId: hex(f[0], `${what}.policyId`), assetName: hex(f[1], `${what}.assetName`) };
}

/** The suite a ConfigDatum names, in the 29-field layout the V4 suites write. */
export function decodeFluidSuite(datum: Uint8Array | string, network: Network, configRef: string): FluidV4Suite {
  const f = fieldsOf(decodePlutusData(datum), 'ConfigDatum', CONFIG_FIELDS);
  return {
    network,
    configRef,
    loanPolicyId: hex(f[6], 'ConfigDatum.loanPolicyId'),
    loanSpendScriptHash: hex(f[10], 'ConfigDatum.loanSpendScriptHash'),
    poolPolicyId: hex(f[2], 'ConfigDatum.poolPolicyId'),
    poolSpendScriptHash: hex(f[8], 'ConfigDatum.poolSpendScriptHash'),
    poolBorrowActionScriptHash: hex(f[23], 'ConfigDatum.poolBorrowActionScriptHash'),
    borrowerBondPolicyId: hex(f[4], 'ConfigDatum.borrowerBondPolicyId'),
    lenderBondPolicyId: hex(f[5], 'ConfigDatum.lenderBondPolicyId'),
  };
}

function liquidationOf(node: PlutusData): FluidLiquidation | null {
  const { constructor: index, fields: f } = constrOf(node, 'LoanDatum.liquidationMode');
  if ((index === 0 || index === 1) && f.length === 0) return null;
  if (index !== 2 || f.length !== 4) refuse(`LiquidationMode has no constructor ${index} of ${f.length} fields`);
  return {
    ltv: int(f[0], 'Liquidation.lTV'),
    ltvDivider: int(f[1], 'Liquidation.lTVDivider'),
    penaltyPerMille: int(f[2], 'Liquidation.partialLiquidationPenaltyPerMille'),
    equityInPrincipalCurrency: bool(f[3], 'Liquidation.equityInPrincipalCurrency'),
  };
}

function repaymentOf(node: PlutusData): FluidRepayment {
  const { constructor: index, fields: f } = constrOf(node, 'LoanDatum.repaymentMode');
  if (index === 0 && f.length === 1) {
    return { mode: 'interest_on_remaining_principal', maxPossibleRecasts: int(f[0], 'max_possible_recasts') };
  }
  if (index === 1 && f.length === 0) return { mode: 'principal_and_interest_on_installments' };
  if (index === 2 && f.length === 2) {
    return {
      mode: 'perpetual',
      apyIncreaseLinearCoefficient: int(f[0], 'PerpetualLoan.apyIncreaseLinearCoefficient'),
      maxPossibleRecasts: int(f[1], 'PerpetualLoan.max_possible_recasts'),
    };
  }
  return refuse(`RepaymentMode has no constructor ${index} of ${f.length} fields`);
}

function collateralOf(node: PlutusData): FluidCollateral {
  const f = fieldsOf(node, 'LoanDatum.collateral', 3);
  const name = constrOf(f[1], 'collateral.maybeAssetName');
  const some = name.constructor === 0 && name.fields.length === 1;
  if (!some && (name.constructor !== 1 || name.fields.length !== 0)) refuse('collateral.maybeAssetName is no Option');
  const oracle = asset(f[2], 'collateral.oracleTokenAsset');
  return {
    policyId: hex(f[0], 'collateral.policyId'),
    assetName: some ? hex(name.fields[0], 'collateral.maybeAssetName') : null,
    oraclePolicyId: oracle.policyId,
    oracleAssetName: oracle.assetName,
  };
}

/** Decode types/loan.ak's 17-field LoanDatum from its inline datum, hex or bytes. */
export function decodeFluidLoanDatum(raw: Uint8Array | string): FluidLoanDatum {
  const f = fieldsOf(decodePlutusData(raw), 'LoanDatum', LOAN_FIELDS);
  return {
    doneRecasts: int(f[0], 'LoanDatum.doneRecasts'),
    principalAmount: int(f[1], 'LoanDatum.principalAmount'),
    lendDateMs: int(f[2], 'LoanDatum.lendDate'),
    repaidInstallments: int(f[3], 'LoanDatum.repaidInstallments'),
    interestRate: int(f[4], 'LoanDatum.interestRate'),
    totalInstallments: int(f[5], 'LoanDatum.totalInstallments'),
    principalAsset: asset(f[6], 'LoanDatum.principalAsset'),
    principalOracleAsset: asset(f[7], 'LoanDatum.principalOracleAsset'),
    installmentPeriodHours: int(f[8], 'LoanDatum.installmentPeriod'),
    initialGracePeriodHours: int(f[9], 'LoanDatum.initialGracePeriod'),
    liquidation: liquidationOf(f[10]),
    repayment: repaymentOf(f[11]),
    repaymentTimeWindowHours: int(f[12], 'LoanDatum.repaymentTimeWindow'),
    penaltyFeeForLateRepayment: int(f[13], 'LoanDatum.penaltyFeeForLateRepayment'),
    repaymentReceipts: bool(f[14], 'LoanDatum.repaymentReceipts'),
    originId: hex(f[15], 'LoanDatum.originId'),
    collateral: collateralOf(f[16]),
  };
}

/** n / d rounded toward negative infinity, for a divisor of either sign. */
export function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return q * d !== n && (n < 0n) !== (d < 0n) ? q - 1n : q;
}

/** n / d rounded toward positive infinity, for a divisor of either sign. */
export function ceilDiv(n: bigint, d: bigint): bigint {
  return -floorDiv(-n, d);
}

/**
 * finance.ak's get_remaining_debt for a perpetual loan at `atMs`, the claim's lower
 * validity bound: ceil(principal * (1 + (c * hoursSinceLastInstallment + m * hoursSoFar^2)
 * / 8760)), c = interestRate / 10^4, m = apyIncreaseLinearCoefficient / 10^6.
 */
export function remainingDebt(datum: FluidLoanDatum, atMs: bigint): bigint {
  const r = datum.repayment;
  if (r.mode !== 'perpetual') refuse(`remainingDebt mirrors perpetual loans; this loan is ${r.mode}`);
  const t = atMs - datum.lendDateMs;
  const paidHours =
    datum.repaidInstallments === 0n
      ? 0n
      : datum.initialGracePeriodHours + datum.installmentPeriodHours * datum.repaidInstallments;
  // Both terms over the common denominator 10^4 * 3.6e6 * 3.6e8 = 10^6 * 3.6e6^2 = 1.296e19.
  const rate = datum.interestRate * (t - paidHours * HOUR_MS) * 360_000_000n + r.apyIncreaseLinearCoefficient * t * t;
  const denominator = 12_960_000_000_000_000_000n * 8760n;
  return ceilDiv(datum.principalAmount * (denominator + rate), denominator);
}

function collateralQuantity(lovelace: bigint, assets: KoiosAsset[], c: FluidCollateral): bigint {
  if (c.policyId === '') return c.assetName === null || c.assetName === '' ? lovelace : 0n;
  return assets
    .filter((a) => a.policy_id === c.policyId && (c.assetName === null || (a.asset_name ?? '') === c.assetName))
    .reduce((n, a) => n + BigInt(a.quantity), 0n);
}

/**
 * The network's pinned suite, read from its config UTxO. Anyone can mint a token named
 * "parameters" under a policy of their own, but only the config validator can write one
 * at the config policy's own script address, so the row must sit there.
 */
export async function readFluidSuite(opts: FluidReadOptions): Promise<FluidV4Suite> {
  const policy = FLUID_V4_CONFIG_POLICY[opts.network];
  if (policy === undefined) refuse(`no FluidTokens V4 suite is pinned for ${opts.network}`);
  const rows = await koiosUtxos(opts, 'asset_utxos', { _asset_list: [[policy, CONFIG_ASSET_NAME]], _extended: true });
  const live = rows.filter((r) => !r.is_spent);
  if (live.length !== 1) refuse(`expected one unspent ${policy}.parameters UTxO on ${opts.network}, found ${live.length}`);
  const row = live[0];
  if (row.payment_cred !== policy) {
    refuse(`the ${policy}.parameters UTxO sits at ${row.payment_cred}, not at the config policy's own script address`);
  }
  if (!row.inline_datum?.bytes) refuse('the config UTxO carries no inline datum');
  return decodeFluidSuite(row.inline_datum.bytes, opts.network, `${row.tx_hash}#${row.tx_index}`);
}

/** The loan a Koios UTxO row holds, or null for a row holding no token of the loan policy. */
function loanOf(row: KoiosUtxo, suite: FluidV4Suite): FluidLoan | null {
  const ref = `${row.tx_hash}#${row.tx_index}`;
  const assets = row.asset_list ?? [];
  const tokens = assets.filter((a) => a.policy_id === suite.loanPolicyId);
  if (tokens.length === 0) return null;
  const loanId = tokens[0].asset_name;
  if (tokens.length !== 1 || tokens[0].quantity !== '1' || !loanId) refuse(`${ref} holds loan tokens no single loan id names`);
  if (!row.inline_datum?.bytes) refuse(`${ref} holds a loan token and no inline datum`);
  const datum = decodeFluidLoanDatum(row.inline_datum.bytes);
  const lovelace = BigInt(row.value);
  return {
    ref,
    loanId,
    lovelace,
    collateralQuantity: collateralQuantity(lovelace, assets, datum.collateral),
    datum,
  };
}

/**
 * Every live loan of `borrowerAddress` in the network's suite: the outputs at the suite's
 * loan script under the borrower's stake credential that hold a loan token.
 */
export async function readFluidLoans(borrowerAddress: string, opts: FluidReadOptions): Promise<FluidLoan[]> {
  const borrower = decodeBech32Address(borrowerAddress);
  if (borrower.networkId !== CHAIN_FACTS[opts.network].networkId) refuse(`${borrowerAddress} is no ${opts.network} address`);
  if (borrower.stake === null) {
    refuse('an address with no stake credential shares its loan address with every such borrower');
  }
  const suite = await readFluidSuite(opts);
  const loanAddress = bech32Address(
    { payment: { kind: 'script', hash: hexToBytes(suite.loanSpendScriptHash) }, stake: borrower.stake },
    opts.network,
  );
  const rows = await koiosUtxos(opts, 'address_utxos', { _addresses: [loanAddress], _extended: true });
  return rows.map((r) => loanOf(r, suite)).filter((l): l is FluidLoan => l !== null);
}

/** The live loan at `loanRef`, refused unless it is an unspent output of the suite's loan script holding a loan. */
export async function readFluidLoan(loanRef: string, suite: FluidV4Suite, opts: FluidReadOptions): Promise<FluidLoan> {
  const rows = await koiosUtxos(opts, 'utxo_info', { _utxo_refs: [loanRef], _extended: true });
  const row = rows.find((r) => `${r.tx_hash}#${r.tx_index}` === loanRef);
  if (row === undefined) refuse(`${opts.network} carries no output ${loanRef}`);
  if (row.is_spent) refuse(`${loanRef} is spent: the loan was repaid, changed or claimed`);
  if (row.payment_cred !== suite.loanSpendScriptHash) refuse(`${loanRef} is not at the suite's loan script`);
  const loan = loanOf(row, suite);
  if (loan === null) refuse(`${loanRef} holds no loan token`);
  return loan;
}

/**
 * The RH1 cover a loan asks for: its debt at the cover's start, never under the principal
 * (before lendDate, the borrow's validity bound, finance.ak's formula runs backwards), for
 * `termDays`, paid if FluidTokens liquidates it. Only a perpetual loan with no installments
 * can never be claimed for lateness, and such a loan has no maturity, so the term is the
 * buyer's within an event policy's bounds.
 */
export function rh1CoverParams(loan: FluidLoan, opts: Rh1CoverOptions): Rh1CoverParams {
  const d = loan.datum;
  if (d.repayment.mode !== 'perpetual' || d.installmentPeriodHours !== 0n) {
    throw new InsurabilityError(
      'LOAN_NOT_COVERABLE',
      `the loan is ${d.repayment.mode} with installmentPeriod ${d.installmentPeriodHours}, so it could be claimed for being late`,
    );
  }
  if (d.principalAsset.policyId !== '') {
    throw new InsurabilityError('LOAN_NOT_COVERABLE', "the loan's debt is not ADA; RH1 covers ADA debt and pays ADA");
  }
  if (d.liquidation === null) {
    throw new InsurabilityError('LOAN_NOT_COVERABLE', 'the loan has no liquidation line');
  }
  if (!Number.isInteger(opts.termDays) || opts.termDays < RH1_MIN_TERM_DAYS || opts.termDays > RH1_MAX_TERM_DAYS) {
    refuse(`an RH1 term runs ${RH1_MIN_TERM_DAYS} to ${RH1_MAX_TERM_DAYS} days, not ${opts.termDays}`);
  }
  const debt = remainingDebt(d, opts.startMs > d.lendDateMs ? opts.startMs : d.lendDateMs);
  const { ltv, ltvDivider, penaltyPerMille } = d.liquidation;
  const price = d.collateral.policyId === '' ? { numerator: 1n, denominator: 1n } : opts.collateralLovelacePerUnit;
  let distanceBps: number | null = null;
  if (price !== undefined && loan.collateralQuantity > 0n) {
    // 1 - (debt / (quantity * price)) / (lTV / lTVDivider), in bps, floored.
    const atLine = loan.collateralQuantity * price.numerator * ltv;
    distanceBps = Number(floorDiv(10_000n * (atLine - debt * price.denominator * ltvDivider), atLine));
  }
  const atPenalty = (debt * penaltyPerMille) / 1000n;
  const toLine = (debt * (ltvDivider - ltv)) / ltv;
  return {
    coverageLovelace: debt,
    startMs: opts.startMs,
    expiryMs: opts.startMs + BigInt(opts.termDays) * DAY_MS,
    trigger: {
      event: 'liquidation',
      loanRef: loan.ref,
      loanId: loan.loanId,
      liquidationLtv: { numerator: ltv, denominator: ltvDivider },
      penaltyPerMille,
      distanceBps,
      lineLossLovelace: atPenalty < toLine ? atPenalty : toLine,
    },
  };
}

/** Read the loan at `loanRef` from the network's suite and return its RH1 cover request. */
export async function coverFluidLoan(
  loanRef: string,
  opts: FluidReadOptions & { termDays: number; startMs?: bigint; collateralLovelacePerUnit?: Rational },
): Promise<FluidCoverRequest> {
  const suite = await readFluidSuite(opts);
  const loan = await readFluidLoan(loanRef, suite, opts);
  const params = rh1CoverParams(loan, {
    startMs: opts.startMs ?? BigInt(Date.now()),
    termDays: opts.termDays,
    collateralLovelacePerUnit: opts.collateralLovelacePerUnit,
  });
  const c = loan.datum.collateral;
  const { network: _network, ...pinned } = suite;
  return {
    network: opts.network,
    row: 'RH1',
    settlement: 'lovelace',
    suite: pinned,
    loan: {
      ref: loan.ref,
      loanId: loan.loanId,
      lendDateMs: loan.datum.lendDateMs,
      principalLovelace: loan.datum.principalAmount,
      collateral: { policyId: c.policyId, assetName: c.assetName, quantity: loan.collateralQuantity },
    },
    ...params,
  };
}
