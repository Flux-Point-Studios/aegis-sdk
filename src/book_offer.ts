// An underwriter's gen-3 offer from its own wallet: the offer an ask names, its output at the
// instance's book, the hosted builder's post of it, and the judgement of that post before the
// wallet signs it.

import { addressHex, bech32Address } from './address';
import { blake2b } from './blake2b';
import { BookRefusal, G3_PREVIEW_FEEDS, bookPost, ledgerPhaseOne, maxFee } from './book';
import type { BookApiOptions, G3Instance, ResolvedOutput } from './book';
import { g3FeedNamed } from './book_buyer';
import { bytesToHex, hexToBytes } from './cbor';
import { CHAIN_FACTS } from './networks';
import { decodePlutusData, encodePlutusData } from './plutus_data';
import type { PlutusData } from './plutus_data';
import { decodeTransaction } from './tx';
import type { Assets, ProtocolParams, TxOutput } from './tx';

const UNIT = 1_000_000n;
const DAY_MS = 86_400_000n;
const BPS = 10_000n;
const CELL_BYTES = 11;
const CLASS_BITS: Readonly<Record<number, bigint>> = { 0: 1n, 1: 2n };
/** The term band an offer opens at unless asked otherwise: never under seven days by default, though the chain's floor is one. */
export const G3_TERM_DAYS: readonly [bigint, bigint] = [7n, 45n];
/** The depth bands an offer opens at by its first row: a Barrier, a Depeg and an event slot's. */
export const G3_DEPTH_BPS: readonly [bigint, bigint] = [1_500n, 5_000n];
export const G3_DEPEG_DEPTH_BPS: readonly [bigint, bigint] = [500n, 5_000n];
export const G3_EVENT_DEPTH_BPS = 5_000n;
export const G3_OFFER_LIFE_DAYS = 60n;
export const G3_MIN_FILL_UNITS = 10n;
/** The lovelace a token offer carries beside its units by default: sixteen legs' carriers at 2.5 ADA. */
export const G3_TOKEN_OFFER_ADA = 40n;
export const G3_OFFER_BUILD_PATH = '/api/book/g3/offers/build';

/** An offer as an underwriter asks for it, quantities in whole units of six decimals. */
export interface G3OfferAsk {
  label?: string;
  /** Pairs the table vectors name (ADA/USD, RH1) or feed policies; each one row of the instance's table. */
  feeds: string[];
  size: bigint;
  class?: number;
  depth?: readonly [bigint, bigint];
  termDays?: readonly [bigint, bigint];
  loadBps?: bigint;
  minFill?: bigint;
  maxFill?: bigint;
  sheet?: string;
  /** Whole ADA a token offer carries; 40 by default. */
  lovelace?: bigint;
  /** Whole receipts a token offer holds beside its units. */
  receipts?: bigint;
}

/** An offer's datum fields, named as the API's routes name them. */
export interface G3OfferFields {
  owner: { key: string };
  manager: null;
  approval: boolean;
  feeds: string[];
  classes: bigint;
  sheet: string;
  load_bps: bigint;
  min_depth_bps: bigint;
  max_depth_bps: bigint;
  min_term_ms: bigint;
  max_term_ms: bigint;
  min_fill: bigint;
  max_fill: bigint;
  expires_at: bigint;
}

export interface G3Offer {
  fields: G3OfferFields;
  lovelace: bigint;
  /** Units by policy and name, hex. */
  tokens: Record<string, bigint>;
}

/** The starter set each instance posts at launch, sized to the preview underwriter's wallet. */
export const G3_STARTER: Readonly<Record<string, readonly G3OfferAsk[]>> = {
  ada: [
    { label: 'ada-barrier-wide', feeds: ['ADA/USD'], size: 500n },
    { label: 'ada-barrier-deep', feeds: ['ADA/USD'], size: 400n, depth: [3_000n, 5_000n] },
    { label: 'ada-barrier-short', feeds: ['ADA/USD'], size: 300n, termDays: [7n, 14n], loadBps: 100n },
  ],
  usdcx: [
    { label: 'usdcx-barrier-backed', feeds: ['ADA/USD'], size: 4_000n, receipts: 20_000n },
    { label: 'usdcx-barrier-short', feeds: ['ADA/USD'], size: 1_000n, receipts: 5_000n, termDays: [7n, 14n] },
    { label: 'usdcx-usdt-depeg', feeds: ['USDT/USD'], size: 3_000n },
  ],
};

interface Cell {
  class: number;
  minDepth: bigint;
  maxDepth: bigint;
  minDays: bigint;
  maxDays: bigint;
  rate: bigint;
}

function cells(packedHex: string): Cell[] {
  const b = hexToBytes(packedHex);
  if (b.length % CELL_BYTES) throw new BookRefusal('sheet-unreadable', `${b.length} bytes is not a whole number of ${CELL_BYTES}-byte cells`);
  const u16 = (at: number) => BigInt((b[at] << 8) | b[at + 1]);
  const out: Cell[] = [];
  for (let at = 0; at < b.length; at += CELL_BYTES) {
    out.push({ class: b[at], minDepth: u16(at + 1), maxDepth: u16(at + 3), minDays: u16(at + 5), maxDays: u16(at + 7), rate: u16(at + 9) });
  }
  return out;
}

/**
 * Whether a cell of the offer's sheet inside its class, depth and term bands asks less than the
 * coverage at its load. A sheet other than its rows' reference sheets is not judged.
 */
function sellsUnderTheCover(f: G3OfferFields, referenceSheets: string[], sheets: Readonly<Record<string, string>>): boolean {
  if (!referenceSheets.includes(f.sheet)) return true;
  const packed = sheets[f.sheet];
  if (packed === undefined) throw new BookRefusal('sheet-unread', `the cells of sheet ${f.sheet} were not read`);
  const loTerm = f.min_term_ms / DAY_MS;
  const hiTerm = f.max_term_ms / DAY_MS;
  return cells(packed).some((c) => (CLASS_BITS[c.class] ?? 0n) & f.classes &&
    c.minDepth <= f.max_depth_bps && f.min_depth_bps <= c.maxDepth &&
    c.minDays <= hiTerm && loTerm <= c.maxDays &&
    c.rate * (BPS + f.load_bps) < 100_000_000n);
}

/**
 * The offer `ask` names at the instance, owned by the key `owner`. Each feed must be one row of
 * the instance's genesis table at the class asked, if one is; the depth band defaults to the
 * band the first row's class is priced over and the term band to seven to forty-five days; the
 * sheet must be one the instance publishes, and an offer whose every cell in its bands asks the
 * whole coverage at its load is refused, since no sale could fill it. `sheets` holds the packed
 * cells of the instance's reference sheets by hash (readG3Sheets).
 */
export function g3Offer(
  instance: G3Instance,
  ask: G3OfferAsk,
  owner: string,
  nowMs: bigint,
  sheets: Readonly<Record<string, string>>,
  feeds: Readonly<Record<string, string>> = G3_PREVIEW_FEEDS,
): G3Offer {
  const rows = ask.feeds.map((spec) => {
    const feed = g3FeedNamed(spec, feeds);
    const held = instance.rows.filter((r) => r.feed === feed && (ask.class === undefined || r.class === ask.class));
    if (held.length !== 1) throw new BookRefusal('feed-not-a-row', `${spec} is ${held.length} rows of the ${instance.name} table`);
    return held[0];
  });
  const first = rows[0];
  const band = first.kind === 1
    ? [G3_EVENT_DEPTH_BPS, G3_EVENT_DEPTH_BPS] as const
    : first.class === 1 ? G3_DEPEG_DEPTH_BPS : G3_DEPTH_BPS;
  const depth = ask.depth ?? band;
  const term = ask.termDays ?? G3_TERM_DAYS;
  const sheet = ask.sheet || first.sheet;
  if (!(sheet in instance.sheets)) {
    throw new BookRefusal('sheet-not-published', `the launch record publishes no sheet ${sheet} for ${instance.name}`);
  }
  const size = ask.size * UNIT;
  const fields: G3OfferFields = {
    owner: { key: owner }, manager: null, approval: false, feeds: rows.map((r) => r.feed), classes: 0n, sheet,
    load_bps: ask.loadBps ?? 0n, min_depth_bps: depth[0], max_depth_bps: depth[1],
    min_term_ms: term[0] * DAY_MS, max_term_ms: term[1] * DAY_MS,
    min_fill: (ask.minFill ?? G3_MIN_FILL_UNITS) * UNIT,
    max_fill: ask.maxFill ? ask.maxFill * UNIT : size,
    expires_at: nowMs + G3_OFFER_LIFE_DAYS * DAY_MS,
  };
  for (const r of rows) fields.classes |= CLASS_BITS[r.class];
  if (!sellsUnderTheCover(fields, rows.map((r) => r.sheet), sheets)) {
    throw new BookRefusal('ask-reaches-the-cover',
      `at load ${fields.load_bps} bps every cell of sheet ${sheet} in the offer's bands asks the whole coverage, so no sale can fill it; ` +
      "an event slot's unit rate needs a negative load");
  }
  if (instance.unit === 'lovelace') {
    if (ask.receipts) throw new BookRefusal('instance-pins-no-receipt', "the ADA instance's offers hold lovelace alone");
    return { fields, lovelace: size, tokens: {} };
  }
  const tokens: Record<string, bigint> = { [instance.unit]: size };
  if (ask.receipts) {
    if (instance.rates.length !== 1) {
      throw new BookRefusal('instance-pins-no-receipt', `the ${instance.name} instance pins ${instance.rates.length} receipts`);
    }
    tokens[instance.rates[0].policy + instance.rates[0].name] = ask.receipts * UNIT;
  }
  return { fields, lovelace: (ask.lovelace ?? G3_TOKEN_OFFER_ADA) * UNIT, tokens };
}

/** An offer's datum, as the book script reads it. */
export function g3OfferDatum(f: G3OfferFields): string {
  const data: PlutusData = {
    constructor: 0,
    fields: [
      { constructor: 0, fields: [hexToBytes(f.owner.key)] }, { constructor: 1, fields: [] },
      { constructor: f.approval ? 1 : 0, fields: [] }, f.feeds.map(hexToBytes), f.classes, hexToBytes(f.sheet),
      f.load_bps, f.min_depth_bps, f.max_depth_bps, f.min_term_ms, f.max_term_ms, f.min_fill, f.max_fill, f.expires_at,
    ],
  };
  return bytesToHex(encodePlutusData(data));
}

function assetsOf(tokens: Record<string, bigint>): Assets {
  const assets: Assets = {};
  for (const [unit, q] of Object.entries(tokens)) (assets[unit.slice(0, 56)] ??= {})[unit.slice(56)] = q;
  return assets;
}

/** The offer output the instance's book holds: the book script under the owner's stake key. */
export function g3OfferOutput(instance: G3Instance, offer: G3Offer, stakeKey: string): TxOutput {
  return {
    address: addressHex(
      { payment: { kind: 'script', hash: hexToBytes(instance.bookHash) }, stake: { kind: 'key', hash: hexToBytes(stakeKey) } },
      CHAIN_FACTS[instance.network].networkId,
    ),
    lovelace: offer.lovelace,
    assets: assetsOf(offer.tokens),
    datum: { kind: 'inline', cbor: g3OfferDatum(offer.fields) },
    scriptRef: null,
  };
}

/** The offer output's bech32 address. */
export function g3OfferAddress(instance: G3Instance, stakeKey: string): string {
  return bech32Address(
    { payment: { kind: 'script', hash: hexToBytes(instance.bookHash) }, stake: { kind: 'key', hash: hexToBytes(stakeKey) } },
    instance.network,
  );
}

/** What the CLI prints of an offer. */
export function g3OfferSummary(o: G3Offer): Record<string, unknown> {
  const f = o.fields;
  return {
    lovelace: o.lovelace, tokens: o.tokens, feeds: f.feeds, classes: f.classes, sheet: f.sheet,
    depth_bps: [f.min_depth_bps, f.max_depth_bps], term_days: [f.min_term_ms / DAY_MS, f.max_term_ms / DAY_MS],
    load_bps: f.load_bps, fill: [f.min_fill, f.max_fill], expires_at: f.expires_at,
  };
}

/** The packed cells of each of the instance's reference sheets, read from the UTxO holding it and held to its hash. */
export function g3SheetCells(sheetHash: string, datum: string): string {
  const packed = decodePlutusData(datum);
  if (!(packed instanceof Uint8Array) || bytesToHex(blake2b(packed, 32)) !== sheetHash) {
    throw new BookRefusal('sheet-not-the-hash', `the datum published as sheet ${sheetHash} is not its cells`);
  }
  return bytesToHex(packed);
}

/** The hosted builder's unsigned post of an offer. */
export interface G3OfferPost {
  unit: string;
  cbor: string;
}

/** POST /api/book/g3/offers/build: the hosted builder writes the post of `offer` from `funding`. */
export async function buildG3OfferPost(
  api: BookApiOptions,
  instance: G3Instance,
  offer: G3Offer,
  ownerStake: string,
  funding: string[],
): Promise<G3OfferPost> {
  const answer = await bookPost(api, instance, G3_OFFER_BUILD_PATH, {
    fields: offer.fields, lovelace: offer.lovelace, tokens: offer.tokens, owner_stake: ownerStake, funding: [...funding].sort(),
  });
  if (typeof answer?.cbor !== 'string') throw new BookRefusal('build-answered-no-body', 'the offer build answer carries no transaction');
  return { unit: String(answer.unit), cbor: answer.cbor };
}

function sameOutput(a: TxOutput, b: TxOutput): boolean {
  const canon = (o: TxOutput) => JSON.stringify([o.address, o.lovelace.toString(), Object.entries(o.assets).map(([p, n]) =>
    [p, Object.entries(n).map(([k, q]) => [k, q.toString()])]), o.datum, o.scriptRef]);
  return canon(a) === canon(b);
}

/**
 * Why the wallet signs no post of `cbor`: it must carry exactly `offer` first, spend only
 * `funding`, pay every other output to the wallet, mint, withdraw, certify, require, reference
 * and run nothing, pay a fee no larger than a maximal transaction's, carry no witness yet, and
 * pass what the route's own answer is held to: no funding shortfall and nothing the ledger's
 * phase one refuses.
 */
export function g3PostProblems(
  cbor: string,
  offer: TxOutput,
  funding: Record<string, ResolvedOutput>,
  walletAddress: string,
  params: ProtocolParams,
): string[] {
  const tx = decodeTransaction(cbor);
  const problems: string[] = [];
  if (!tx.outputs.length || !sameOutput(tx.outputs[0], offer)) problems.push('the post does not carry the offer asked for first');
  if (!tx.inputs.length || !tx.inputs.every((r) => r in funding)) problems.push('the post spends a UTxO the wallet did not name');
  if (tx.outputs.slice(1).some((o) => o.address !== walletAddress)) problems.push('the post pays away from the wallet');
  const carried: Array<[string, boolean]> = [
    ['aux', tx.auxiliaryData !== null || tx.auxiliaryDataHash !== null],
    ['certificates', tx.certificates > 0],
    ['collateral', tx.collateral.length > 0],
    ['collateral_return', tx.collateralReturn !== null],
    ['donation', tx.donation !== null],
    ['mint', Object.keys(tx.mint).length > 0],
    ['other_body_keys', tx.otherBodyKeys.length > 0],
    ['redeemers', tx.redeemers.length > 0 || tx.scriptDataHash !== null],
    ['reference_inputs', tx.referenceInputs.length > 0],
    ['required_signers', tx.requiredSigners.length > 0],
    ['total_collateral', tx.totalCollateral !== null],
    ['withdrawals', tx.withdrawals.length > 0],
    ['witnesses', tx.otherWitnessKeys.length > 0],
  ];
  const extra = carried.filter(([, on]) => on).map(([name]) => name);
  if (extra.length) problems.push(`the post carries ${extra.join(', ')}`);
  if (tx.fee > maxFee(params)) problems.push(`the post's fee ${tx.fee} is over a maximal transaction's ${maxFee(params)}`);
  if (tx.vkeyWitnesses.length) problems.push('the bytes already carry a witness');
  if (problems.length) return problems;
  const held = tx.inputs.reduce((s, r) => s + funding[r].lovelace, 0n);
  const paid = tx.outputs.reduce((s, o) => s + o.lovelace, 0n) + tx.fee;
  if (paid > held) problems.push(`the funding is ${paid - held} lovelace short of the offer, its fee and its change`);
  return [...problems, ...ledgerPhaseOne(cbor, funding, params).map((p) => `${p.conjunct}: ${p.detail}`)];
}
