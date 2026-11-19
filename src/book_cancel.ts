// A gen-3 buyer's cancel inside the cancellation window: the position read from the sale that
// wrote it, the standing reading of its feed, and the BuyerCancel that pays the premium less
// the cancellation fee to the payee in the instance's unit and returns each leg home less its
// own refund. The reads, the body, its fee point, the refusals and the mirror that judges the
// body before the wallet signs are the Python CLI's (buy_g3_cover cancel), and
// fixtures/g3_cancel_vectors.json holds this module to its bytes.

import { addressHex, addressHexOfData, bech32Address, fullAddressOfHex } from './address';
import {
  BookRefusal,
  credentialsOf,
  decodeFeedReading,
  decodeG3LegDatum,
  decodeG3PolicyDatum,
  markerOf,
  quantity,
  readResolvedOutputs,
  resolvedOutputsFromKoios,
} from './book';
import type { FeedReading, G3Instance, G3LegDatum, G3PolicyDatum, ResolvedOutput } from './book';
import { g3AddressView } from './book_buyer';
import { bytesToHex, hexToBytes } from './cbor';
import { ChainError, InputError } from './errors';
import { koiosEvaluateTransaction, koiosProtocolParams, koiosRows, koiosTipMs, koiosUtxos } from './koios';
import type { KoiosReadOptions } from './koios';
import { CHAIN_FACTS, posixMsToSlot, slotToPosixMs } from './networks';
import { constrOf, dataHex, dataInt, decodePlutusData, encodePlutusData } from './plutus_data';
import type { PlutusConstr, PlutusData } from './plutus_data';
import { decodeTransaction, encodeTransaction, ledgerSize, minFee, minUtxo, requiredCollateral, scriptDataHash, sortRefs } from './tx';
import type { Assets, DecodedTransaction, ProtocolParams, TxDraft, TxOutput, TxRedeemer } from './tx';

const P_PREFIX = '50';
const C_PREFIX = '43';
/** The share of each leg's premium a buyer's cancel keeps back. */
export const G3_CANCEL_FEE_BPS = 1_000n;
/** How long after its start a policy may be cancelled. */
export const G3_CANCEL_WINDOW_MS = 1_800_000n;
const CANCEL_TTL_MS = 300_000n;
const LOWER_SLACK_MS = 60_000n;
const TRAILING_LOW_WINDOW_MS = 46n * 3_600_000n;
const MAX_READING_VALIDITY_MS = 2n * 3_600_000n;
/** Where the refund and the first return stand among a cancel's outputs. */
const REFUND_AT = 0;
const RETURNS_AT = 1;
const FEE_ROUNDS = 6;
const ARMS = ['Claim', 'Expire', 'BuyerCancel'];

type Units = readonly [bigint, bigint];
// Each line (base, per leg, per input besides the P-leg and the legs), as
// sovereign_g3_settlement.UNITS declares it over the applied scripts' measured runs.
const UNITS: Readonly<Record<'BuyerCancel' | 'SettleLeg', readonly [Units, Units, Units]>> = {
  BuyerCancel: [[564_000n, 190_000_000n], [249_000n, 83_500_000n], [11_000n, 3_500_000n]],
  SettleLeg: [[156_000n, 45_500_000n], [5_000n, 3_000_000n], [5_000n, 3_000_000n]],
};
const BURN_UNITS: Units = [60_000n, 16_000_000n];
// The oracle observer's: base, and per reference input it scans to the reading.
const OBSERVER_UNITS: readonly [Units, Units] = [[270_000n, 95_000_000n], [22_000n, 7_000_000n]];

/** A UTxO of a position: its P-leg or a C-leg. */
export interface G3PositionOutput {
  ref: string;
  output: ResolvedOutput;
}

/** An open position as its sale left it. */
export interface G3Position {
  /** The digest its markers name. */
  digest: string;
  pLeg: G3PositionOutput;
  /** Its C-legs, in out-ref order. */
  legs: G3PositionOutput[];
  policy: G3PolicyDatum;
}

/** The publisher's standing reading of a feed. */
export interface G3StandingReading {
  ref: string;
  output: ResolvedOutput;
  reading: FeedReading;
}

/** What a buyer's cancel pays, as the Python CLI prints it. */
export interface G3CancelSummary {
  fee: bigint;
  /** The summed refund in the instance's unit. */
  refund: bigint;
  /** Each leg's return, in out-ref order: the offer it came from, where it goes and what it holds. */
  returns: Array<{ offer: string; to: string; lovelace: bigint; plain: bigint; receipts: bigint }>;
}

/** A departure the mirror names: a stable code, its first failing conjunct, every one, and why. */
export interface G3SettlementProblem {
  code: string;
  detail: string;
  conjunct: string;
  conjuncts: string[];
}

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', `g3 cancel: ${message}`);
}

/** Python's repr of a list of strings or integers, as the refusals it is compared with print it. */
function pyList(items: Array<string | number>): string {
  return `[${items.map((x) => (typeof x === 'string' ? `'${x}'` : String(x))).join(', ')}]`;
}

function constr(index: number, fields: PlutusData[]): PlutusConstr {
  return { constructor: index, fields };
}

function dataCbor(data: PlutusData): string {
  return bytesToHex(encodePlutusData(data));
}

function outRefData(ref: string): PlutusConstr {
  const [tx, ix] = ref.split('#');
  return constr(0, [hexToBytes(tx), BigInt(ix)]);
}

function inlineOf(o: Pick<TxOutput, 'datum'>): string | null {
  return o.datum?.kind === 'inline' ? o.datum.cbor : null;
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    if (e instanceof InputError) return null;
    throw e;
  }
}

function networkIdOf(instance: G3Instance): number {
  return CHAIN_FACTS[instance.network].networkId;
}

/** Whether two addresses' bytes name the same credentials, whatever network id each header carries. */
function sameAddress(a: string, b: string): boolean {
  return a.length === b.length && a[0] === b[0] && a.slice(2) === b.slice(2);
}

function isScriptAt(o: ResolvedOutput, hash: string): boolean {
  const pay = credentialsOf(o.address).payment;
  return pay?.kind === 'script' && pay.hash === hash;
}

function inUnit(instance: G3Instance, o: Pick<TxOutput, 'lovelace' | 'assets'>): bigint {
  return instance.unitPolicy ? quantity(o.assets, instance.unitPolicy, instance.unitName) : o.lovelace;
}

function nonZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [p, names] of Object.entries(assets)) {
    const kept = Object.entries(names).filter(([, q]) => q !== 0n);
    if (kept.length) out[p] = Object.fromEntries(kept);
  }
  return out;
}

function sameAssets(a: Assets, b: Assets): boolean {
  const flat = (x: Assets) => JSON.stringify(Object.keys(x).sort().map((p) => [p, Object.keys(x[p]).sort().map((n) => [n, String(x[p][n])])]));
  return flat(nonZero(a)) === flat(nonZero(b));
}

/** The leg's refund: its premium less the cancellation fee. */
export function g3CancelRefund(premium: bigint): bigint {
  return premium - (premium * G3_CANCEL_FEE_BPS) / 10_000n;
}

// --- the position -------------------------------------------------------------------

/** The sale's P-leg and its legs by output index, as the sale's own body states them. */
function saleOutputs(sale: DecodedTransaction, instance: G3Instance): { pAt: number | null; legsAt: number[] } {
  const position = instance.positionHash;
  let pAt = sale.outputs.findIndex((o) => markerOf(o.assets, position, P_PREFIX) !== null);
  if (pAt < 0) pAt = sale.outputs.findIndex((o) => attempt(() => decodeG3PolicyDatum(inlineOf(o) ?? '')) !== null);
  const legsAt = sale.outputs.flatMap((o, at) => {
    const pay = credentialsOf(o.address).payment;
    return markerOf(o.assets, position, C_PREFIX) !== null && pay?.kind === 'script' && pay.hash === position ? [at] : [];
  });
  return { pAt: pAt < 0 ? null : pAt, legsAt };
}

/** The open position whose P-leg is `ref` among `outputs`, every C-leg of its digest beside it. */
function positionAmong(instance: G3Instance, ref: string, outputs: Record<string, ResolvedOutput>): G3Position {
  const position = instance.positionHash;
  const pName = markerOf(outputs[ref].assets, position, P_PREFIX);
  if (pName === null) refuse(`${ref} carries no P marker`);
  const digest = pName.slice(P_PREFIX.length);
  const legs = sortRefs(Object.keys(outputs).filter((r) =>
    markerOf(outputs[r].assets, position, P_PREFIX) === null && markerOf(outputs[r].assets, position, C_PREFIX) === C_PREFIX + digest));
  if (!legs.length) refuse(`${ref} has no leg left`);
  const policy = attempt(() => decodeG3PolicyDatum(inlineOf(outputs[ref]) ?? ''));
  if (policy === null) refuse(`${ref} holds no PolicyDatum a decoder reads`);
  return { digest, pLeg: { ref, output: outputs[ref] }, legs: legs.map((r) => ({ ref: r, output: outputs[r] })), policy };
}

/**
 * The open position whose P-leg is `ref`, its legs read from the sale that wrote them: refused
 * not-a-position for any other output of a sale and position-settled once any of it is spent.
 */
export async function readG3Position(instance: G3Instance, ref: string, koios: KoiosReadOptions): Promise<G3Position> {
  if (!/^[0-9a-f]{64}#(0|[1-9][0-9]*)$/.test(ref)) refuse(`${ref} is not txid#index`);
  const txHash = ref.split('#')[0];
  const sold = (await koiosRows<{ tx_hash: string; cbor: string }>(koios, 'tx_cbor', { _tx_hashes: [txHash] }))
    .find((row) => row.tx_hash === txHash);
  if (!sold) throw new ChainError('UNKNOWN', `Koios has no transaction ${txHash}`);
  const { pAt, legsAt } = saleOutputs(decodeTransaction(sold.cbor), instance);
  if (pAt === null || ref !== `${txHash}#${pAt}`) throw new BookRefusal('not-a-position', `${ref} is not the P-leg of the sale ${txHash}`);
  const refs = [ref, ...legsAt.map((at) => `${txHash}#${at}`)];
  const rows = await koiosUtxos(koios, 'utxo_info', { _utxo_refs: refs, _extended: true });
  const listed = new Map(rows.map((row) => [`${row.tx_hash}#${row.tx_index}`, row]));
  const missing = refs.filter((r) => !listed.has(r));
  if (missing.length) throw new ChainError('UNKNOWN', `Koios carries no output ${pyList(missing.slice(0, 3))}`);
  const spent = refs.filter((r) => listed.get(r)?.is_spent).sort();
  if (spent.length) throw new BookRefusal('position-settled', `${pyList(spent)} are spent`);
  return positionAmong(instance, ref, resolvedOutputsFromKoios(refs.map((r) => listed.get(r)!)));
}

// --- the reading --------------------------------------------------------------------

/**
 * The standing reading of `feed` among `outputs`: of those at the publisher's key holding the
 * feed's one token and nothing else, whose datum reads as a reading, the last in out-ref order.
 */
export function g3StandingReading(instance: G3Instance, feed: string, outputs: Record<string, ResolvedOutput>): G3StandingReading | null {
  let found: G3StandingReading | null = null;
  for (const ref of Object.keys(outputs).sort()) {
    const o = outputs[ref];
    const pay = credentialsOf(o.address).payment;
    const held = nonZero(o.assets);
    const policies = Object.keys(held);
    const names = Object.values(held[feed] ?? {});
    if (pay?.kind !== 'key' || pay.hash !== instance.publisherVkh || policies.length !== 1 || policies[0] !== feed
      || names.length !== 1 || names[0] !== 1n) continue;
    const reading = attempt(() => decodeFeedReading(inlineOf(o) ?? ''));
    if (reading !== null) found = { ref, output: o, reading };
  }
  return found;
}

/** The publisher's standing reading of `feed` as Koios lists the outputs holding the feed's tokens. */
export async function readG3Reading(instance: G3Instance, feed: string, koios: KoiosReadOptions): Promise<G3StandingReading | null> {
  const holders = await koiosRows<{ asset_name: string | null; quantity: string | number }>(koios, 'policy_asset_addresses', { _asset_policy: feed });
  const names = [...new Set(holders.filter((h) => String(h.quantity) !== '0').map((h) => h.asset_name ?? ''))].sort();
  if (!names.length) return null;
  const rows = await koiosUtxos(koios, 'asset_utxos', { _asset_list: names.map((n) => [feed, n]), _extended: true });
  return g3StandingReading(instance, feed, resolvedOutputsFromKoios(rows.filter((row) => !row.is_spent)));
}

// --- the body -----------------------------------------------------------------------

export interface G3BuyerCancelPlan {
  instance: G3Instance;
  position: G3Position;
  reading: G3PositionOutput;
  /** A key UTxO of lovelace alone the cancel puts up as collateral. */
  collateral: G3PositionOutput;
  /** The instance's reference-script UTxOs, by out-ref. */
  scripts: Record<string, ResolvedOutput>;
  tipMs: bigint;
  params: ProtocolParams;
}

function floorS(ms: bigint): bigint {
  return ms - (((ms % 1000n) + 1000n) % 1000n);
}

function ceilS(ms: bigint): bigint {
  return -floorS(-ms);
}

function payeeOf(policy: G3PolicyDatum, networkId: number): string {
  return policy.payoutAddress !== null
    ? addressHexOfData(policy.payoutAddress, networkId)
    : addressHex({ payment: { kind: 'key', hash: hexToBytes(policy.insured) }, stake: null }, networkId);
}

/** Where a leg returns: its owner under the stake credential the leg sat at. */
function legHome(held: ResolvedOutput, leg: G3LegDatum, networkId: number): string {
  const stake = credentialsOf(held.address).stake;
  return addressHex({
    payment: { kind: leg.owner.kind, hash: hexToBytes(leg.owner.hash) },
    stake: stake && { kind: stake.kind, hash: hexToBytes(stake.hash) },
  }, networkId);
}

/** The datum a leg's return carries: for a script owner the out-ref of the offer that funded it. */
function returnTag(leg: G3LegDatum): string | null {
  return leg.owner.kind === 'script' ? dataCbor(outRefData(leg.source)) : null;
}

/** What a leg owes once its C marker burns: its whole value, less `refund` of the unit. */
function legOwed(instance: G3Instance, held: ResolvedOutput, cName: string, refund: bigint): { lovelace: bigint; assets: Assets } {
  const assets: Assets = Object.fromEntries(Object.entries(held.assets).map(([p, names]) => [p, { ...names }]));
  const take = (policy: string, name: string, q: bigint) => {
    assets[policy] ??= {};
    assets[policy][name] = (assets[policy][name] ?? 0n) - q;
  };
  take(instance.positionHash, cName, 1n);
  let lovelace = held.lovelace;
  if (instance.unitPolicy) take(instance.unitPolicy, instance.unitName, refund);
  else lovelace -= refund;
  return { lovelace, assets: nonZero(assets) };
}

function output(address: string, lovelace: bigint, assets: Assets, datum: string | null): TxOutput {
  return { address, lovelace, assets, datum: datum === null ? null : { kind: 'inline', cbor: datum }, scriptRef: null };
}

function linear(line: readonly Units[], counts: bigint[]): Units {
  return [0, 1].map((u) => line.reduce((s, term, i) => s + term[u] * counts[i], 0n)) as unknown as Units;
}

/**
 * The BuyerCancel { own_at, refund_at = 0, returns_at = 1 } of `plan.position`, unsigned: the
 * summed refund in the unit to the payee, each leg home less its own refund from output 1, the
 * markers burned, the reading attested, the insured a required signer and the fee at the
 * ledger's figure for the declared units. Refused as the Python builder refuses, by its code.
 */
export function buildG3BuyerCancel(plan: G3BuyerCancelPlan): TxDraft {
  const { instance: inst, position, params } = plan;
  const pd = position.policy;
  if (pd.payoutDatum !== null) {
    throw new BookRefusal('payout-datum-committed', 'the policy commits a payout datum, which no sale of a generation-3 instance leaves');
  }
  const networkId = networkIdOf(inst);
  const legRefs = sortRefs(position.legs.map((l) => l.ref));
  const held = Object.fromEntries(position.legs.map((l) => [l.ref, l.output]));
  const inputs = sortRefs([position.pLeg.ref, ...legRefs]);
  const ownAt = inputs.indexOf(position.pLeg.ref);
  const pName = P_PREFIX + position.digest;
  const cName = C_PREFIX + position.digest;
  const payee = payeeOf(pd, networkId);
  const observed = decodeFeedReading(inlineOf(plan.reading.output) ?? '');
  const deposit = position.pLeg.output.lovelace;
  const tip = plan.tipMs;
  let lower = floorS(tip - LOWER_SLACK_MS);
  let upper = tip + CANCEL_TTL_MS < pd.startMs + G3_CANCEL_WINDOW_MS ? tip + CANCEL_TTL_MS : pd.startMs + G3_CANCEL_WINDOW_MS;
  if (ceilS(observed.observedAt) > lower) lower = ceilS(observed.observedAt);
  if (observed.validUntil < upper) upper = observed.validUntil;
  upper = floorS(upper);
  if (!(lower <= tip && tip < upper)) {
    throw new BookRefusal('stale-reading', `the reading observed at ${observed.observedAt} and valid until ${observed.validUntil} leaves no range open at ${tip}`);
  }

  const legs = legRefs.map((r) => ({ ref: r, held: held[r], leg: decodeG3LegDatum(inlineOf(held[r]) ?? '') }));
  const returns = legs.map(({ held: out, leg }) => {
    const owed = legOwed(inst, out, cName, g3CancelRefund(leg.premium));
    return output(legHome(out, leg, networkId), owed.lovelace, owed.assets, returnTag(leg));
  });
  const refund = legs.reduce((s, { leg }) => s + g3CancelRefund(leg.premium), 0n);

  const referenceInputs = sortRefs([inst.refScripts.position, inst.refScripts.observer, plan.reading.ref]);
  const counts = [1n, BigInt(legs.length), BigInt(inputs.length - 1 - legs.length)];
  const attestation: PlutusData = [constr(0, [constr(2, []), hexToBytes(pd.feed), constr(0, [
    observed.spot, observed.observedAt, observed.validUntil, observed.min12h, observed.lowAt, constr(0, []),
  ])])];
  const redeemer = (purpose: TxRedeemer['purpose'], index: number, data: PlutusData, [mem, steps]: Units): TxRedeemer =>
    ({ purpose, index, data: dataCbor(data), mem, steps });
  const redeemers: TxRedeemer[] = [
    redeemer('spend', ownAt, constr(3, [BigInt(ownAt), BigInt(REFUND_AT), BigInt(RETURNS_AT)]), linear(UNITS.BuyerCancel, counts)),
    ...legRefs.map((r) => redeemer('spend', inputs.indexOf(r), constr(4, []), linear(UNITS.SettleLeg, counts))),
    redeemer('mint', 0, constr(1, []), BURN_UNITS),
    redeemer('withdraw', 0, attestation, linear(OBSERVER_UNITS, [1n, BigInt(referenceInputs.length)])),
  ];
  const draft: TxDraft = {
    inputs, outputs: [], fee: 0n,
    validFromSlot: posixMsToSlot(lower, inst.network), validToSlot: posixMsToSlot(upper, inst.network),
    withdrawals: [{ credential: { kind: 'script', hash: inst.observerHash }, networkId, amount: 0n }],
    mint: { [inst.positionHash]: { [cName]: -BigInt(legs.length), [pName]: -1n } },
    auxiliaryDataHash: null, scriptDataHash: null, collateral: [], requiredSigners: [pd.insured], networkId: null,
    collateralReturn: null, totalCollateral: null, referenceInputs, donation: null, redeemers, auxiliaryData: null,
  };

  const resolved: Record<string, ResolvedOutput> = {
    [position.pLeg.ref]: position.pLeg.output, ...held, [plan.reading.ref]: plan.reading.output,
    [plan.collateral.ref]: plan.collateral.output, ...plan.scripts,
  };
  const recorded = new Set([inst.refScripts.position, inst.refScripts.book, inst.refScripts.observer, inst.refScripts.liqwid]);
  let referenceScriptBytes = 0;
  for (const r of [...inputs, ...referenceInputs]) {
    const script = resolved[r]?.referenceScript ?? null;
    if (recorded.has(r) && script === null) throw new BookRefusal('reference-script-unresolved', `${r} is resolved with no script size to charge`);
    referenceScriptBytes += script?.size ?? 0;
  }
  const collateralPay = credentialsOf(plan.collateral.output.address).payment;
  const witnesses = new Set([pd.insured, ...(collateralPay?.kind === 'key' ? [collateralPay.hash] : [])]).size;

  const apply = (fee: bigint) => {
    const bounty = deposit - fee;
    const homes = returns.map((o) => ({ ...o, assets: nonZero(o.assets) }));
    const paid = inst.unitPolicy
      ? output(payee, 0n, { [inst.unitPolicy]: { [inst.unitName]: refund } }, null)
      : output(payee, refund, {}, null);
    let topped = 0n;
    for (const o of inst.unitPolicy ? [...homes, paid] : homes) {
      const floor = minUtxo(o, params);
      const lift = floor > o.lovelace ? floor - o.lovelace : 0n;
      o.lovelace += lift;
      topped += lift;
    }
    if (topped > bounty) {
      throw new BookRefusal('bounty-short', `lifting the returns to their min-UTxO takes ${topped} lovelace, more than the bounty and the settler's inputs hold (${bounty})`);
    }
    paid.lovelace += bounty - topped;
    draft.fee = fee;
    draft.outputs = [paid, ...homes];
    draft.collateral = [plan.collateral.ref];
    const total = requiredCollateral(fee, params);
    draft.totalCollateral = total;
    if (plan.collateral.output.lovelace > total) {
      draft.collateralReturn = output(plan.collateral.output.address, plan.collateral.output.lovelace - total, {}, null);
    }
  };
  let fee = 0n;
  for (let round = 0; round < FEE_ROUNDS; round++) {
    apply(fee);
    const need = minFee(draft, params, { witnesses, referenceScriptBytes });
    if (need <= fee) break;
    fee = need;
  }
  apply(fee);

  const [problem] = g3BuyerCancelProblems(draft, inst, resolved);
  if (problem) throw new BookRefusal(problem.code, problem.detail);
  const small = draft.outputs.flatMap((o, at) => (o.lovelace < minUtxo(o, params) ? [at] : []));
  if (small.length) throw new BookRefusal('output-under-the-min-utxo', `outputs ${pyList(small)} hold less than their min-UTxO`);
  const size = ledgerSize(draft, witnesses);
  if (size > params.maxTxSize) throw new BookRefusal('transaction-over-the-max-size', `${size} bytes over ${params.maxTxSize}`);
  const mem = redeemers.reduce((s, r) => s + r.mem, 0n);
  const steps = redeemers.reduce((s, r) => s + r.steps, 0n);
  if (mem > params.maxTxMem || steps > params.maxTxSteps) {
    throw new BookRefusal('units-over-the-transaction-maximum', `${mem} memory and ${steps} steps over ${params.maxTxMem} and ${params.maxTxSteps}`);
  }
  draft.scriptDataHash = scriptDataHash(redeemers, params.costModelsV3);
  return draft;
}

/** What a built cancel pays, in the Python CLI's words: its fee, the refund and each leg's return. */
export function g3CancelSummary(draft: TxDraft, position: G3Position, instance: G3Instance): G3CancelSummary {
  const pin = position.policy.extension === null ? null : constrOf(position.policy.extension, 'the receipt pin').fields;
  const legs = sortRefs(position.legs.map((l) => l.ref)).map((r) => decodeG3LegDatum(inlineOf(position.legs.find((l) => l.ref === r)!.output) ?? ''));
  return {
    fee: draft.fee,
    refund: legs.reduce((s, leg) => s + g3CancelRefund(leg.premium), 0n),
    returns: legs.map((leg, k) => {
      const home = draft.outputs[RETURNS_AT + k];
      return {
        offer: leg.source,
        to: bech32Address(fullAddressOfHex(home.address), instance.network),
        lovelace: home.lovelace,
        plain: inUnit(instance, home),
        receipts: pin ? quantity(home.assets, dataHex(pin[0], 'the pinned policy'), dataHex(pin[1], 'the pinned name')) : 0n,
      };
    }),
  };
}

// --- the mirror ---------------------------------------------------------------------

function named(code: string, failing: Array<[string, string]>): G3SettlementProblem {
  return { code, detail: failing.map(([, d]) => d).join('; '), conjunct: failing[0][0], conjuncts: failing.map(([c]) => c) };
}

interface Coordinator {
  name: string;
  fields: bigint[];
}

const POSITION_REDEEMERS: Readonly<Record<number, [string, number]>> = {
  0: ['Underwrite', 8], 1: ['Claim', 2], 2: ['Expire', 2], 3: ['BuyerCancel', 3], 4: ['SettleLeg', 0],
};

/** A PositionRedeemer's name and integer fields; null for any other Data. */
function coordinatorOf(data: string | null): Coordinator | null {
  if (data === null) return null;
  return attempt(() => {
    const c = constrOf(decodePlutusData(data), 'a PositionRedeemer');
    const shape = POSITION_REDEEMERS[c.constructor];
    if (!shape || c.fields.length !== shape[1]) refuse('no PositionRedeemer');
    return { name: shape[0], fields: shape[0] === 'Underwrite' ? [] : c.fields.map((f) => dataInt(f, 'a redeemer field')) };
  });
}

function readingAmong(tx: TxDraft, instance: G3Instance, resolved: Record<string, ResolvedOutput>, feed: string): FeedReading | null {
  for (const r of tx.referenceInputs) {
    const o = resolved[r];
    if (!o) continue;
    const pay = credentialsOf(o.address).payment;
    if (instance.publisherVkh && !(pay?.kind === 'key' && pay.hash === instance.publisherVkh)) continue;
    const reading = attempt(() => decodeFeedReading(inlineOf(o) ?? ''));
    if (reading !== null && (!feed || feed in nonZero(o.assets))) return reading;
  }
  return null;
}

function fresh(r: FeedReading, lower: bigint, upper: bigint): boolean {
  const trailing = r.lowAt > 0n;
  return (!trailing || r.lowAt <= r.observedAt) && (!trailing || r.lowAt >= r.observedAt - TRAILING_LOW_WINDOW_MS)
    && lower >= r.observedAt && lower <= r.validUntil && upper <= r.validUntil && r.validUntil <= r.observedAt + MAX_READING_VALIDITY_MS;
}

function sameData(written: string, datum: string | null): boolean {
  if (datum === null) return false;
  if (datum === written) return true;
  const canonical = (hex: string) => attempt(() => dataCbor(decodePlutusData(hex)));
  const a = canonical(datum);
  return a !== null && a === canonical(written);
}

/**
 * Why the wallet must not sign `tx` as a buyer's cancel of a gen-3 position, judged on
 * `resolved`, the chain's own outputs: sovereign_g3_settlement.settlement_problems, conjunct
 * by conjunct; empty when every one holds. A body whose coordinator is a Claim or an Expire is
 * refused rather than judged.
 */
export function g3BuyerCancelProblems(tx: TxDraft, instance: G3Instance, resolved: Record<string, ResolvedOutput>): G3SettlementProblem[] {
  const position = instance.positionHash;
  const networkId = networkIdOf(instance);
  const lower = tx.validFromSlot === null ? null : slotToPosixMs(tx.validFromSlot, instance.network);
  const upper = tx.validToSlot === null ? null : slotToPosixMs(tx.validToSlot, instance.network);

  const pRef = tx.inputs.find((r) => resolved[r] && isScriptAt(resolved[r], position) && markerOf(resolved[r].assets, position, P_PREFIX) !== null) ?? null;
  const pd = pRef === null ? null : attempt(() => decodeG3PolicyDatum(inlineOf(resolved[pRef]) ?? ''));
  const pName = pRef === null ? null : markerOf(resolved[pRef].assets, position, P_PREFIX);
  const cName = pName === null ? null : C_PREFIX + pName.slice(P_PREFIX.length);
  const order = sortRefs(tx.inputs);
  const legs = order.filter((r) => resolved[r] && cName !== null && quantity(resolved[r].assets, position, cName) === 1n)
    .map((r) => ({ held: resolved[r], leg: attempt(() => decodeG3LegDatum(inlineOf(resolved[r]) ?? '')) }));
  const spendAt = pRef === null ? -1 : order.indexOf(pRef);
  const coordinatorData = [...tx.redeemers].reverse().find((r) => r.purpose === 'spend' && r.index === spendAt)?.data ?? null;
  const coordinator = pRef === null ? null : coordinatorOf(coordinatorData);
  if (coordinator?.name === 'Claim' || coordinator?.name === 'Expire') refuse(`the mirror judges a buyer cancel, not a ${coordinator.name}`);
  const problems: G3SettlementProblem[] = [];

  let failing: Array<[string, string]> = [];
  const withdrawals = tx.withdrawals.filter((w) => !(w.credential.kind === 'script' && w.credential.hash === instance.liqwidHash));
  if (withdrawals.length > 1 || withdrawals.some((w) => !(w.credential.kind === 'script' && w.credential.hash === instance.observerHash))) {
    failing.push(['foreign-withdrawal', 'a withdrawal at other than the observer']);
  }
  if (Object.keys(tx.mint).some((p) => p !== position)) failing.push(['foreign-mint', 'a mint under other than the position policy']);
  if (tx.inputs.some((r) => {
    const pay = resolved[r] ? credentialsOf(resolved[r].address).payment : null;
    return pay?.kind === 'script' && pay.hash !== position;
  })) failing.push(['foreign-script-input', "a script input that is not the position's"]);
  if (failing.length) problems.push(named('settlement-foreign-purpose', failing));

  const minted = tx.mint[position] ?? {};
  if (Object.values(minted).some((q) => q >= 0n)) problems.push(named('burn-not-negative', [['non-negative-quantity', 'a non-negative quantity under the position policy']]));

  failing = [];
  const arm = coordinator !== null && ARMS.includes(coordinator.name);
  if (pd === null) failing.push(['no-p-leg', 'the body spends no P-leg']);
  else if (!arm) failing.push(['no-coordinator-redeemer', 'the P-leg is spent under no settlement arm']);
  if (pd !== null) {
    const covered = legs.reduce((s, { leg }) => s + (leg ? leg.coverage : 0n), 0n);
    if (covered !== pd.coverage) failing.push(['leg-left-behind', `the spent legs cover ${covered} of ${pd.coverage}`]);
    const burned = Object.entries(minted).filter(([, q]) => q < 0n);
    const whole: Record<string, bigint> = { [cName as string]: -BigInt(legs.length), [pName as string]: -1n };
    if (burned.length !== Object.keys(whole).length || burned.some(([n, q]) => whole[n] !== q)) {
      failing.push(['burn-not-the-marker-set', "the burn is not the position's whole marker set"]);
    }
  }
  if (failing.length) problems.push(named('settlement-legs-incomplete', failing));
  if (pd === null || coordinator === null || !arm) return problems;
  const [, refundAt, returnsAt] = coordinator.fields;

  if (lower !== null && upper !== null) {
    failing = [];
    const reading = readingAmong(tx, instance, resolved, pd.feed);
    const { strike, startMs: start } = pd;
    if (reading === null) {
      failing.push(['reading-not-referenced', 'no feed reading among the reference inputs']);
    } else {
      const { lowAt: low, min12h: min12 } = reading;
      if (reading.spot <= strike || (min12 <= strike && low > 0n && low >= start)) failing.push(['in-the-money', 'the reading shows the policy in the money']);
      if (min12 <= strike && 0n < low && low < start) failing.push(['born-broken', 'the reading shows the strike broken before the start']);
      if (!fresh(reading, lower, upper)) failing.push(['stale-reading', "the reading is not fresh over the body's range"]);
    }
    if (upper > start + G3_CANCEL_WINDOW_MS) failing.push(['after-the-cancellation-window', 'the cancel passes the cancellation window']);
    if (!tx.requiredSigners.includes(pd.insured)) failing.push(['insured-not-signing', 'the insured is not a required signer']);
    if (failing.length) problems.push(named('buyer-cancel-gate', failing));
  }

  const foreign: Array<[string, string]> = [];
  if (pd.poolScriptHash !== position) foreign.push(['pool-script-not-the-position', "the policy's pool_script_hash is not this instance's"]);
  if (pd.poolNft !== instance.beaconPolicy) foreign.push(['beacon-not-the-instance', "the policy's pool_nft is not this instance's"]);
  if (foreign.length) problems.push(named('policy-not-the-instance', foreign));

  failing = [];
  const outs = tx.outputs;
  const at = (i: bigint) => (i >= 0n && i < BigInt(outs.length) ? outs[Number(i)] : null);
  for (const [k, { held, leg }] of legs.entries()) {
    const o = at(returnsAt + BigInt(k));
    if (leg === null || o === null || !sameAddress(o.address, legHome(held, leg, networkId))) {
      failing.push(['return-not-home', `leg ${k} is not returned home`]);
      break;
    }
    const tag = returnTag(leg);
    if (tag !== null && !sameData(tag, inlineOf(o))) failing.push(['return-not-tagged', `the return of leg ${k} does not carry its offer's out-ref`]);
    const want = legOwed(instance, held, cName as string, g3CancelRefund(leg.premium));
    if (!sameAssets(o.assets, want.assets)) failing.push(['return-not-token-exact', `the return of leg ${k} does not hold exactly its tokens`]);
    if (o.lovelace < want.lovelace) failing.push(['return-under-the-leg', `leg ${k} is returned short of its lovelace`]);
    if (failing.length) break;
  }
  const refunded = at(refundAt);
  const owed = legs.reduce((s, { leg }) => s + (leg ? g3CancelRefund(leg.premium) : 0n), 0n);
  if (refunded === null || !sameAddress(refunded.address, payeeOf(pd, networkId))) failing.push(['refund-not-the-payee', 'the refund is not at the payee']);
  else if (inUnit(instance, refunded) < owed) failing.push(['refund-under-the-sum', 'the refund is under the summed refund in the unit']);
  if (returnsAt <= refundAt && refundAt < returnsAt + BigInt(legs.length)) {
    failing.push(['refund-inside-the-returns-block', 'the refund sits inside the returns block']);
  }
  if (failing.length) problems.push(named('settlement-pays-short', failing));
  return problems;
}

// --- the cancel ---------------------------------------------------------------------

export interface G3BuyerCancelRequest {
  instance: G3Instance;
  /** The position's P-leg out-ref. */
  position: string;
  /** The insured's bech32 address and a UTxO of lovelace alone at it to put up as collateral. */
  wallet: { address: string; collateral: string };
  koios: KoiosReadOptions;
  /** The chain's tip; read from Koios when absent. */
  tipMs?: bigint;
  /** Read from Koios's cli_protocol_params when absent. */
  params?: ProtocolParams;
}

export interface G3PreparedCancel {
  /** The unsigned transaction, hex: the insured's key signs it. */
  tx: string;
  draft: TxDraft;
  summary: G3CancelSummary;
}

/** The reference scripts a settlement of the instance runs, by role. */
function scriptRoles(instance: G3Instance): Array<'position' | 'observer' | 'liqwid'> {
  return instance.rates.length ? ['position', 'observer', 'liqwid'] : ['position', 'observer'];
}

/**
 * The buyer's cancel of the position whose P-leg is `request.position`, read from Koios, built,
 * judged by the mirror and evaluated by Koios's Ogmios: refused with the Python CLI's code and
 * detail wherever it refuses (not-a-position, position-settled, not-the-insured, no-reading,
 * the builder's codes, cancel-not-the-position, cancel-not-evaluated). Nothing is signed.
 */
export async function prepareG3BuyerCancel(request: G3BuyerCancelRequest): Promise<G3PreparedCancel> {
  const { instance: inst, koios } = request;
  const absent = [
    ...(inst.publisherVkh ? [] : ['publisherVkh']),
    ...scriptRoles(inst).filter((role) => !inst.refScripts[role]).map((role) => `refScripts.${role}`),
  ];
  if (absent.length) refuse(`the ${inst.name} instance records no ${absent.join(', ')}`);
  const position = await readG3Position(inst, request.position, koios);
  const pd = position.policy;
  const payment = g3AddressView(request.wallet.address).payment;
  const vkh = 'key' in payment ? payment.key : null;
  if (pd.insured !== vkh) throw new BookRefusal('not-the-insured', `the wallet's key ${vkh} is not the insured ${pd.insured}`);
  const [held] = await koiosUtxos(koios, 'utxo_info', { _utxo_refs: [request.wallet.collateral], _extended: true });
  if (!held || held.is_spent) refuse(`the collateral ${request.wallet.collateral} is not unspent`);
  const collateral = resolvedOutputsFromKoios([held])[request.wallet.collateral];
  if (Object.keys(nonZero(collateral.assets)).length) refuse(`the collateral ${request.wallet.collateral} holds a token`);
  const reading = await readG3Reading(inst, pd.feed, koios);
  if (reading === null) throw new BookRefusal('no-reading', `no standing reading of ${pd.feed} is read`);
  const scripts = await readResolvedOutputs(scriptRoles(inst).map((role) => inst.refScripts[role] as string), koios);
  const tipMs = request.tipMs ?? await koiosTipMs(koios);
  const params = request.params ?? await koiosProtocolParams(koios);
  const draft = buildG3BuyerCancel({
    instance: inst, position, reading, collateral: { ref: request.wallet.collateral, output: collateral }, scripts, tipMs, params,
  });
  const resolved: Record<string, ResolvedOutput> = {
    [position.pLeg.ref]: position.pLeg.output, ...Object.fromEntries(position.legs.map((l) => [l.ref, l.output])),
    [reading.ref]: reading.output, [request.wallet.collateral]: collateral, ...scripts,
  };
  const problems = g3BuyerCancelProblems(draft, inst, resolved);
  if (problems.length) throw new BookRefusal('cancel-not-the-position', problems.map((p) => `${p.code}: ${p.detail}`).join('; '));
  const tx = bytesToHex(encodeTransaction(draft));
  try {
    await koiosEvaluateTransaction(tx, koios);
  } catch (e) {
    if (e instanceof ChainError) throw new BookRefusal('cancel-not-evaluated', e.message);
    throw e;
  }
  return { tx, draft, summary: g3CancelSummary(draft, position, inst) };
}
