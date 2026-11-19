// One transaction that borrows from a FluidTokens V4 pool and buys gen-3 Book cover in it.
//
// The borrow's scripts pin the pool continuation at output 0 and find the loan and both bonds
// by the indexes its redeemer names, so its four outputs stand first; the Book's Underwrite
// names every output it reads by index, so its outputs follow at whatever offset that leaves.
// The Treasury's cut goes to an accrual output rather than the body's key-22 donation, which
// the position validator counts only when its pair is the whole mint. The relay's mark is aux
// data no script can read, so the whole body is built here, balanced on one change output.

import { addressHex } from './address';
import { bytesToHex, hexToBytes } from './cbor';
import { InputError } from './errors';
import type { FluidV4Suite } from './fluid_v4';
import {
  FLUID_LENDER_BOND_DATUM,
  FLUID_POOL_SPEND_REDEEMER,
  fluidBondRedeemer,
  fluidBorrowGuards,
  fluidBorrowRedeemer,
  fluidLoanDatum,
  fluidLoanId,
  fluidLoanMintRedeemer,
  fluidPoolWithdrawRedeemer,
  fluidRedeemerPosition,
} from './fluid_v4_borrow';
import {
  decodeFeedReading,
  g3DigestDatum,
  g3Digest,
  g3Donation,
  g3PolicyDatum,
  g3ProtocolFee,
} from './book';
import type { G3Instance, ResolvedOutput } from './book';
import { slotToPosixMs } from './networks';
import { constrOf, dataHex, decodePlutusData, encodePlutusData } from './plutus_data';
import type { PlutusConstr, PlutusData } from './plutus_data';
import { minFee, minUtxo, requiredCollateral, scriptDataHash } from './tx';
import type { Assets, ProtocolParams, TxDatum, TxDraft, TxOutput, TxRedeemer, Withdrawal } from './tx';
import type { PlutusFullAddress } from './types';

/** One leg of the cover: `coverage` from the offer at `offer`, priced at `cell` of the sheet `sheet`. */
export interface G3LegPlan {
  offer: string;
  coverage: bigint;
  premium: bigint;
  sheet: string;
  cell: number;
}

export interface FluidCoverPlan {
  suite: FluidV4Suite;
  /** The UTxO holding each FluidTokens script the borrow runs, by script hash. */
  fluidScripts: Record<string, string>;
  pool: string;
  principal: bigint;
  collateral: bigint;
  /** The borrower's address bytes, hex: the borrower bond, the loan's stake key and the change. */
  borrower: string;
  /** The borrower's wallet UTxOs the transaction spends. */
  funding: string[];
  /** An ADA-only wallet UTxO put up as collateral. */
  collateralInput: string;
  validFromSlot: bigint;
  validToSlot: bigint;
  cover: {
    instance: G3Instance;
    /** The lane Head the sale spends. */
    head: string;
    /** The publisher reading of the cover's feed. */
    reading: string;
    /** The instance's table. */
    table: string;
    insured: string;
    feed: string;
    class: number;
    strike: bigint;
    startMs: bigint;
    termMs: bigint;
    legs: G3LegPlan[];
  };
  /** The chain's reads of every output the plan names. */
  resolved: Record<string, ResolvedOutput>;
  params: ProtocolParams;
  /** Each redeemer's units from an evaluation; each redeemer at an equal share of the budget when absent. */
  units?: Array<Pick<TxRedeemer, 'purpose' | 'index' | 'mem' | 'steps'>>;
}

export interface FluidCoverTx {
  draft: TxDraft;
  loanId: string;
  digest: string;
  /** Where each obligation stands among the outputs. */
  layout: { pool: number; loan: number; borrowerBond: number; lenderBond: number; head: number; pLeg: number; legs: number; conts: number; fee: number; accrual: number; change: number };
  /** The reference-script bytes the fee is priced on. */
  referenceScriptBytes: number;
  /** The key witnesses the fee is priced on. */
  witnesses: number;
}

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', `fluid cover: ${message}`);
}

function sortRefs(refs: string[]): string[] {
  const key = (r: string) => {
    const [tx, ix] = r.split('#');
    return [tx, Number(ix)] as const;
  };
  return [...new Set(refs)].sort((a, b) => {
    const [ta, ia] = key(a);
    const [tb, ib] = key(b);
    return ta < tb ? -1 : ta > tb ? 1 : ia - ib;
  });
}

function constr(index: number, fields: PlutusData[]): PlutusConstr {
  return { constructor: index, fields };
}

function outRef(ref: string): PlutusConstr {
  const [tx, ix] = ref.split('#');
  return constr(0, [hexToBytes(tx), BigInt(ix)]);
}

function at(resolved: Record<string, ResolvedOutput>, ref: string, what: string): ResolvedOutput {
  const o = resolved[ref];
  if (!o) refuse(`the chain's reads hold no ${what} ${ref}`);
  return o;
}

function inline(o: ResolvedOutput, what: string): string {
  if (o.datum?.kind !== 'inline') refuse(`${what} carries no inline datum`);
  return o.datum.cbor;
}

function output(address: string, lovelace: bigint, assets: Assets, datum: string | TxDatum | null): TxOutput {
  return { address, lovelace, assets, datum: typeof datum === 'string' ? { kind: 'inline', cbor: datum } : datum, scriptRef: null };
}

function atMinUtxo(o: TxOutput, params: ProtocolParams): TxOutput {
  return { ...o, lovelace: minUtxo(o, params) };
}

function credentialOf(node: PlutusData, what: string): { kind: 'key' | 'script'; hash: Uint8Array } {
  const c = constrOf(node, what);
  if (c.constructor > 1 || c.fields.length !== 1) refuse(`${what} is no credential`);
  return { kind: c.constructor === 0 ? 'key' : 'script', hash: hexToBytes(dataHex(c.fields[0], what)) };
}

/** An Address as Data, inline stake only, as its bytes on `networkId`. */
function addressOfData(node: PlutusData, networkId: number): string {
  const [payment, stake] = constrOf(node, 'an address').fields;
  const pay = credentialOf(payment, 'the payment credential');
  const opt = constrOf(stake, 'the stake credential');
  const inlineStake = opt.constructor === 0 ? constrOf(opt.fields[0], 'the stake reference') : null;
  if (inlineStake && inlineStake.constructor !== 0) refuse('a pointer stake credential is no address this writes');
  const st = inlineStake ? credentialOf(inlineStake.fields[0], 'the stake credential') : null;
  return addressHex({ payment: pay, stake: st }, networkId);
}

function fullAddressOf(hex: string): PlutusFullAddress {
  const bytes = hexToBytes(hex);
  const type = bytes[0] >> 4;
  if (type > 3 && type !== 6 && type !== 7) refuse('an address that is no base or enterprise address');
  return {
    payment: { kind: type & 1 ? 'script' : 'key', hash: bytes.slice(1, 29) },
    stake: type < 4 ? { kind: type & 2 ? 'script' : 'key', hash: bytes.slice(29, 57) } : null,
  };
}

function addAssets(into: Assets, from: Assets, sign: bigint): void {
  for (const [p, names] of Object.entries(from)) {
    for (const [n, q] of Object.entries(names)) {
      into[p] ??= {};
      into[p][n] = (into[p][n] ?? 0n) + sign * q;
      if (into[p][n] === 0n) delete into[p][n];
    }
    if (into[p] && Object.keys(into[p]).length === 0) delete into[p];
  }
}

/**
 * The borrow and the cover as one unsigned transaction, balanced on one change output to the
 * borrower, its fee and collateral at the ledger's figures for its key witnesses.
 */
export function composeFluidBorrowWithCover(plan: FluidCoverPlan): FluidCoverTx {
  const { suite, resolved, params, cover } = plan;
  const inst = cover.instance;
  if (inst.unit !== 'lovelace') refuse('the composer sells cover of the ADA instance');
  if (cover.legs.length === 0) refuse('the cover has no leg');
  const networkId = hexToBytes(plan.borrower)[0] & 0x0f;
  const validFromMs = slotToPosixMs(plan.validFromSlot, suite.network);
  const validToMs = slotToPosixMs(plan.validToSlot, suite.network);

  // The borrow.
  const poolOut = at(resolved, plan.pool, 'pool');
  const poolDatumHex = inline(poolOut, 'the pool');
  const poolDatum = decodePlutusData(poolDatumHex);
  fluidBorrowGuards(poolDatum, { principal: plan.principal, collateral: plan.collateral, validFromMs, validToMs });
  const poolIds = Object.keys(poolOut.assets[suite.poolPolicyId] ?? {});
  if (poolIds.length !== 1) refuse(`the pool holds ${poolIds.length} pool NFTs`);
  const poolId = poolIds[0];
  const loanId = fluidLoanId(plan.pool);
  const borrower = fullAddressOf(plan.borrower);
  if (!borrower.stake) refuse('the borrower address carries no stake credential for the loan');
  const poolFields = constrOf(poolDatum, 'the pool datum').fields;
  const poolCont = output(poolOut.address, poolOut.lovelace - plan.principal, poolOut.assets, poolDatumHex);
  if (poolCont.lovelace < minUtxo(poolCont, params)) refuse('lending the principal leaves the pool under its min-UTxO');
  const loan = output(
    addressHex({ payment: { kind: 'script', hash: hexToBytes(suite.loanSpendScriptHash) }, stake: borrower.stake }, networkId),
    plan.collateral,
    { [suite.loanPolicyId]: { [loanId]: 1n } },
    bytesToHex(encodePlutusData(fluidLoanDatum(poolDatum, { collateralIndex: 0, principal: plan.principal, validToMs, poolId }))),
  );
  const borrowerBond = atMinUtxo(output(plan.borrower, 0n, { [suite.borrowerBondPolicyId]: { [loanId]: 1n } }, null), params);
  const lenderBond = atMinUtxo(
    output(addressOfData(poolFields[4], networkId), 0n, { [suite.lenderBondPolicyId]: { [loanId]: 1n } },
      bytesToHex(encodePlutusData(FLUID_LENDER_BOND_DATUM))),
    params,
  );

  // The cover.
  const headOut = at(resolved, cover.head, 'Head');
  const digest = g3Digest(cover.head);
  const digestDatum = g3DigestDatum(digest);
  const offers = sortRefs(cover.legs.map((l) => l.offer));
  if (offers.length !== cover.legs.length) refuse('two legs name one offer');
  const legs = offers.map((ref) => cover.legs.find((l) => l.offer === ref) as G3LegPlan);
  const coverage = legs.reduce((s, l) => s + l.coverage, 0n);
  const premium = legs.reduce((s, l) => s + l.premium, 0n);
  const pLeg = output(
    addressHex({ payment: { kind: 'script', hash: hexToBytes(inst.positionHash) }, stake: null }, networkId),
    0n,
    { [inst.positionHash]: { ['50' + digest]: 1n } },
    bytesToHex(g3PolicyDatum({
      digest, insured: cover.insured, strike: cover.strike, coverage, premium, startMs: cover.startMs,
      expiryMs: cover.startMs + cover.termMs, feed: cover.feed, class: cover.class,
    }, inst)),
  );
  pLeg.lovelace = minUtxo(pLeg, params);
  const legOuts: TxOutput[] = [];
  const conts: TxOutput[] = [];
  for (const leg of legs) {
    const offer = at(resolved, leg.offer, 'offer');
    const offerDatum = inline(offer, `offer ${leg.offer}`);
    const owner = constrOf(decodePlutusData(offerDatum), 'the offer datum').fields[0];
    const offerStake = fullAddressOf(offer.address).stake;
    if (!offerStake) refuse(`offer ${leg.offer} carries no stake credential a leg can keep`);
    legOuts.push(output(
      addressHex({ payment: { kind: 'script', hash: hexToBytes(inst.positionHash) }, stake: offerStake }, networkId),
      leg.coverage,
      { [inst.positionHash]: { ['43' + digest]: 1n } },
      bytesToHex(encodePlutusData(constr(0, [owner, leg.coverage, leg.premium, outRef(leg.offer), hexToBytes(digest)]))),
    ));
    const left = offer.lovelace + leg.premium - leg.coverage;
    if (left < 0n) refuse(`offer ${leg.offer} holds less than its leg's coverage`);
    if (left > 0n) conts.push(output(offer.address, left, {}, offerDatum));
  }
  const feeOut = output(inst.treasury, g3ProtocolFee(premium, inst, params), {}, digestDatum);
  const accrualOut = output(
    addressHex({ payment: { kind: 'script', hash: hexToBytes(inst.accrualHash) }, stake: null }, networkId),
    0n, {}, digestDatum,
  );
  const owed = g3Donation(premium, inst);
  const accrualFloor = minUtxo(accrualOut, params);
  accrualOut.lovelace = owed > accrualFloor ? owed : accrualFloor;

  const outputs = [poolCont, loan, borrowerBond, lenderBond, output(headOut.address, headOut.lovelace, headOut.assets, headOut.datum), pLeg, ...legOuts, ...conts, feeOut, accrualOut];
  const layout = {
    pool: 0, loan: 1, borrowerBond: 2, lenderBond: 3, head: 4, pLeg: 5, legs: 6, conts: 6 + legOuts.length,
    fee: 6 + legOuts.length + conts.length, accrual: 7 + legOuts.length + conts.length, change: 8 + legOuts.length + conts.length,
  };

  const inputs = sortRefs([plan.pool, cover.head, ...offers, ...plan.funding]);
  const fluidRefs = [suite.poolSpendScriptHash, suite.poolPolicyId, suite.poolBorrowActionScriptHash, suite.loanPolicyId,
    suite.lenderBondPolicyId, suite.borrowerBondPolicyId].map((h) => {
    const ref = plan.fluidScripts[h];
    if (!ref) refuse(`no reference input carries the FluidTokens script ${h}`);
    return ref;
  });
  const sheets = [...new Set(legs.map((l) => {
    const ref = inst.sheets[l.sheet];
    if (!ref) refuse(`the instance names no sheet ${l.sheet}`);
    return ref;
  }))];
  const referenceInputs = sortRefs([
    suite.configRef, ...fluidRefs, inst.refScripts.position, inst.refScripts.book, inst.refScripts.observer,
    cover.table, cover.reading, ...sheets,
  ]);
  const configIndex = BigInt(referenceInputs.indexOf(suite.configRef));

  const mint: Assets = {
    [suite.loanPolicyId]: { [loanId]: 1n },
    [suite.lenderBondPolicyId]: { [loanId]: 1n },
    [suite.borrowerBondPolicyId]: { [loanId]: 1n },
    [inst.positionHash]: { ['43' + digest]: BigInt(legs.length), ['50' + digest]: 1n },
  };
  const mints = Object.keys(mint).sort();
  const withdrawalHashes = [suite.poolBorrowActionScriptHash, suite.poolPolicyId, inst.observerHash].sort();
  const withdrawals: Withdrawal[] = withdrawalHashes.map((hash) => ({ credential: { kind: 'script', hash }, networkId, amount: 0n }));

  const reading = decodeFeedReading(inline(at(resolved, cover.reading, 'reading'), 'the reading'));
  const attestation: PlutusData = [constr(0, [constr(2, []), hexToBytes(cover.feed),
    constr(0, [reading.spot, reading.observedAt, reading.validUntil, reading.min12h, reading.lowAt, constr(0, [])])])];
  const headIndex = BigInt(inputs.indexOf(cover.head));
  const underwrite = constr(0, [
    coverage, premium, BigInt(layout.head), BigInt(layout.pLeg), BigInt(layout.legs), BigInt(layout.conts), BigInt(layout.fee),
    legs.map((l) => [BigInt(referenceInputs.indexOf(inst.sheets[l.sheet])), BigInt(l.cell)]),
  ]);
  const data: Array<[TxRedeemer['purpose'], number, PlutusData]> = [
    ['spend', inputs.indexOf(plan.pool), FLUID_POOL_SPEND_REDEEMER],
    ['spend', inputs.indexOf(cover.head), underwrite],
    ...offers.map((r): [TxRedeemer['purpose'], number, PlutusData] => ['spend', inputs.indexOf(r), constr(0, [headIndex])]),
    ['mint', mints.indexOf(inst.positionHash), constr(0, [])],
    ['mint', mints.indexOf(suite.lenderBondPolicyId), fluidBondRedeemer(plan.pool)],
    ['mint', mints.indexOf(suite.borrowerBondPolicyId), fluidBondRedeemer(plan.pool)],
    ['withdraw', withdrawalHashes.indexOf(suite.poolBorrowActionScriptHash), fluidBorrowRedeemer({
      configIndex, borrower, lenderBondOutput: BigInt(layout.lenderBond), borrowerBondOutput: BigInt(layout.borrowerBond),
      principalOracleIndex: -1n, collateralIndex: 0n, collateralOracleIndex: -1n, principal: plan.principal, poolId,
      permissionIndex: 0n,
    })],
    ['withdraw', withdrawalHashes.indexOf(suite.poolPolicyId), fluidPoolWithdrawRedeemer(configIndex)],
    ['withdraw', withdrawalHashes.indexOf(inst.observerHash), attestation],
  ];
  const loanMint = { purpose: 'mint', index: mints.indexOf(suite.loanPolicyId) };
  const keys = [...data.map(([purpose, index]) => ({ purpose, index })), loanMint];
  const origin = fluidRedeemerPosition(keys, { purpose: 'withdraw', index: withdrawalHashes.indexOf(suite.poolPolicyId) });
  data.push(['mint', loanMint.index, fluidLoanMintRedeemer(configIndex, BigInt(origin))]);
  const share = BigInt(data.length);
  const redeemers: TxRedeemer[] = data.map(([purpose, index, d]) => {
    const measured = plan.units?.find((u) => u.purpose === purpose && u.index === index);
    return {
      purpose, index, data: bytesToHex(encodePlutusData(d)),
      mem: measured?.mem ?? params.maxTxMem / share, steps: measured?.steps ?? params.maxTxSteps / share,
    };
  });

  // Balance.
  const value: Assets = {};
  let lovelace = 0n;
  for (const r of inputs) {
    const o = at(resolved, r, 'input');
    lovelace += o.lovelace;
    addAssets(value, o.assets, 1n);
  }
  addAssets(value, mint, 1n);
  for (const o of outputs) {
    lovelace -= o.lovelace;
    addAssets(value, o.assets, -1n);
  }
  if (Object.values(value).some((names) => Object.values(names).some((q) => q < 0n))) refuse('the outputs take a token no input holds');
  const keyHashes = new Set([cover.insured]);
  for (const r of [...inputs, plan.collateralInput]) {
    const header = hexToBytes(at(resolved, r, 'input').address)[0];
    if (header >> 4 <= 7 && ((header >> 4) & 1) === 0) keyHashes.add(at(resolved, r, 'input').address.slice(2, 58));
  }
  const refBytes = sortRefs([...inputs, ...referenceInputs]).reduce((s, r) => s + (at(resolved, r, 'reference').referenceScript?.size ?? 0), 0);
  const collateralOut = at(resolved, plan.collateralInput, 'collateral');
  if (Object.keys(collateralOut.assets).length) refuse('the collateral input holds a token');

  const draft: TxDraft = {
    inputs, outputs: [], fee: 0n, validFromSlot: plan.validFromSlot, validToSlot: plan.validToSlot, withdrawals, mint,
    auxiliaryDataHash: null, scriptDataHash: scriptDataHash(redeemers, params.costModelsV3), collateral: [plan.collateralInput],
    requiredSigners: [cover.insured], networkId: null, collateralReturn: null, totalCollateral: null, referenceInputs,
    donation: null, redeemers, auxiliaryData: null,
  };
  const settle = (fee: bigint) => {
    const change = output(plan.borrower, lovelace - fee, value, null);
    if (change.lovelace < minUtxo(change, params)) refuse(`the wallet is ${minUtxo(change, params) - change.lovelace} lovelace short of the outputs, the fee and its change`);
    const total = requiredCollateral(fee, params);
    draft.fee = fee;
    draft.outputs = [...outputs, change];
    draft.totalCollateral = total;
    draft.collateralReturn = output(collateralOut.address, collateralOut.lovelace - total, {}, null);
  };
  let fee = 0n;
  for (let i = 0; i < 8; i++) {
    settle(fee);
    const least = minFee(draft, params, { witnesses: keyHashes.size, referenceScriptBytes: refBytes });
    if (least <= fee) break;
    fee = least;
  }
  settle(fee);
  return { draft, loanId, digest, layout, referenceScriptBytes: refBytes, witnesses: keyHashes.size };
}
