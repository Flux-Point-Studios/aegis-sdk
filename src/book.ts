// Gen-3 Sovereign Book cover bought from a buyer's own wallet.
//
// The flow is the Aegis API's buyer flow: quote a request, have the insured's wallet
// signData the reservation payload, prepare (the API reserves the funding and presents
// the sale's bytes), judge those bytes here against the chain's own reads before anything
// is signed, then signTx and submit. verifyG3Sale is that judgement: it names each way a
// presented sale departs from the request, the quote, the instance and the ledger's
// phase one, and an empty list is the only answer a wallet should sign on.

import type { Network } from './address';
import { addressBytes, addressHex } from './address';
import { blake2b } from './blake2b';
import { bytesToHex, concat, encodeBytes, encodeConstr, hexToBytes } from './cbor';
import { AegisError, InputError } from './errors';
import type { MinimalFetch } from './fetch_quote';
import { koiosUtxos } from './koios';
import type { KoiosReadOptions, KoiosUtxo } from './koios';
import { CHAIN_FACTS, slotToPosixMs } from './networks';
import { constrOf, dataHex, dataInt, decodePlutusData, encodePlutusData, fieldsOf, outRefDigest } from './plutus_data';
import type { PlutusData } from './plutus_data';
import {
  decodeTransaction,
  ledgerSize,
  minFee,
  minUtxo,
  requiredCollateral,
  spliceVkeyWitnesses,
  transactionId,
  txViewOf,
} from './tx';
import type { Assets, DecodedTransaction, ProtocolParams, TxOutput } from './tx';

/** A receipt a pinned policy may be paid part of its cover in: the one rate source an instance compiles. */
export interface G3ReceiptPin {
  policy: string;
  name: string;
}

/** A rate source an instance's vector compiles: the receipt, its MarketState and the floor it reads. */
export interface G3RateSource extends G3ReceiptPin {
  statePolicy: string;
  stateName: string;
  stateScript: string;
  floor: string[];
  liqDiv: bigint;
}

/** A row of an instance's genesis table: a feed at a class, its kind (1 for an event slot) and its reference sheet. */
export interface G3TableRow {
  feed: string;
  class: number;
  kind: number;
  sheet: string;
}

/** A deployed gen-3 instance: the scripts, tokens and rates a sale of it is judged against. */
export interface G3Instance {
  network: Network;
  /** The launch record's name for it: 'ada' or 'usdcx'. */
  name: string;
  /** 'lovelace' for the ADA instance, else the unit's policy and name. */
  unit: string;
  /** '' for the ADA instance. */
  unitPolicy: string;
  unitName: string;
  /** The lovelace each leg carries beside the unit; 0 for the ADA instance. */
  legCarrier: bigint;
  /** The Liqwid observer a pinned sale withdraws zero from; '' for none. */
  liqwidHash: string;
  /** The ADA/USD feed the unit is priced against; '' for the ADA instance. */
  fxFeed: string;
  fxScale: bigint;
  rates: G3RateSource[];
  rows: G3TableRow[];
  positionHash: string;
  bookHash: string;
  /** The table script's hash, which is also its token's policy. */
  tableHash: string;
  tableName: string;
  accrualHash: string;
  observerHash: string;
  beaconPolicy: string;
  beaconName: string;
  /** The treasury's address bytes, hex. */
  treasury: string;
  publisherVkh: string;
  feeBps: bigint;
  donationBps: bigint;
  minPremium: bigint;
  minLegPremium: bigint;
  minLegCoverage: bigint;
  maxLegs: number;
  /** The lane Heads, by lane. */
  heads: string[];
  refScripts: { position: string; book: string; observer: string; accrual: string; table: string; liqwid?: string };
  /** Pricing sheets by hash, each at the UTxO holding it. */
  sheets: Record<string, string>;
}

const ADA_USD_PREVIEW = '4bba53d510bf2af7d08e8edf57c3a49ccdb6b0406c8470eea03081ef';
const USDC_USD_PREVIEW = '344a79ba3e109002b6e5c362e922963dc9ef8d5b4f91590cb0731c17';
const USDT_USD_PREVIEW = '89e30ef6634ef796c26bf51c31fec4c0eb6893f5ecce3f2f7dd5da05';
const RH1_PREVIEW = 'e78e97ccaa0b795eb7ca00a7b2f514e3419db33d5e8bed4af0054c82';
const BARRIER_SHEET_PREVIEW = '972e9a6f37447d906eedaee839d6e2a67659189394090c2b49dab6a6f6c3f280';
const STABLE_SHEET_PREVIEW = '66898227feaf904e3744250537476ecf2ae67a98c108945b6aaabe685346d499';
const EVENT_SHEET_PREVIEW = '26f7e3bf9a8d2f465536796b95545d98ebac231c04f1f0b96d5f611a5950de64';

/** Each preview feed by the pair the table vectors name it by, an event slot by its own. */
export const G3_PREVIEW_FEEDS: Readonly<Record<string, string>> = {
  [USDC_USD_PREVIEW]: 'USDC/USD',
  [ADA_USD_PREVIEW]: 'ADA/USD',
  [USDT_USD_PREVIEW]: 'USDT/USD',
  [RH1_PREVIEW]: 'RH1',
};

/** The ADA instance on preview. */
export const G3_PREVIEW_ADA: G3Instance = {
  network: 'preview',
  name: 'ada',
  unit: 'lovelace',
  unitPolicy: '',
  unitName: '',
  legCarrier: 0n,
  liqwidHash: '',
  fxFeed: '',
  fxScale: 1n,
  rates: [],
  rows: [
    { feed: ADA_USD_PREVIEW, class: 0, kind: 0, sheet: BARRIER_SHEET_PREVIEW },
    { feed: USDC_USD_PREVIEW, class: 1, kind: 0, sheet: STABLE_SHEET_PREVIEW },
    { feed: USDT_USD_PREVIEW, class: 1, kind: 0, sheet: STABLE_SHEET_PREVIEW },
    { feed: RH1_PREVIEW, class: 0, kind: 1, sheet: EVENT_SHEET_PREVIEW },
  ],
  positionHash: '60e9069318a5a5f6adcd8be58a04a616e50fe14f7359d82239843537',
  bookHash: '5027f0652fc707ea4fdba2bbc6d312beb6ed3b15ca65a9e7d625ccb5',
  tableHash: 'f07f33e36027037190ab528c3e03cbcabc0a3c4a6419355edcdaa3a9',
  tableName: '41454749535f424f4f4b5f5441424c45',
  accrualHash: '0457b39838e82e70bb0672860face954ce1c8c99d71591316ae43f30',
  observerHash: '8f5b93aefb8f471f19128ab92e56d04b2435e9f88bcdfd35238211c8',
  beaconPolicy: 'c1e132480c38cf39c6e0244d7ae81b4dd04cad81d96129da946ddf84',
  beaconName: '41454749535f424f4f4b5f4c414e45',
  treasury:
    '00' + '8ff4cf576f4fac298132d7aa0300bcc00d5e617b5d84c996b3e79726' + 'd36534b58c1f85dd4855e8f92600463a62b982dbee2a7568e29fb0e9',
  publisherVkh: 'f4b09d9bd4226de67e6ac6b2352554d4d4aa7e405e1efcc1f54b3903',
  feeBps: 200n,
  donationBps: 50n,
  minPremium: 20_000_000n,
  minLegPremium: 1_000_000n,
  minLegCoverage: 2_000_000n,
  maxLegs: 18,
  heads: [0, 1, 2, 3].map((i) => `9b9df872bf82aeaf2f03a9c297fa44450cff0499a48f3b8345aaae1c97dd08ae#${i}`),
  refScripts: {
    position: '03866d9beb09014515428a76f9e4c05539552b706194feb70084c739d8461ea9#0',
    book: '3ad41ef9aad2352212c0e7cdf0f69c187eab8a508675a549ae78c9707280849c#0',
    observer: '9de2148efb27ee18e4c169566860c92928dfcf097c1349549ad74c4d810fc222#0',
    accrual: '0b3f28848b6b718b083b44f1cc8f7b95fe196e9c484f44c010bd22a3a89f0c20#0',
    table: 'ed577bdb8109d08b3ac048241bd804bee9e8e84e1f3f5245cfc339ca279f8600#0',
  },
  sheets: {
    '972e9a6f37447d906eedaee839d6e2a67659189394090c2b49dab6a6f6c3f280':
      'bc72910169088cc81aa1af1197141f04b745537cc23dd4f21d1af2e3734e2abc#0',
    '66898227feaf904e3744250537476ecf2ae67a98c108945b6aaabe685346d499':
      '3ed87d346c5961718088f0ef12ea2a036a99c994521c23411f24a136041cd17b#0',
    '26f7e3bf9a8d2f465536796b95545d98ebac231c04f1f0b96d5f611a5950de64':
      'b3a56f4956935f674439b742700a871a469b5d7cbaaf7176c26659cd88f17ae3#0',
  },
};

/** The USDCx instance on preview: legs carry 2.5 ADA beside the unit, and a pin may name qUSDCx-i. */
export const G3_PREVIEW_USDCX: G3Instance = {
  network: 'preview',
  name: 'usdcx',
  unit: 'd8906ca5c7ba124a0407a32dab37b2c82b13b3dcd9111e42940dcea45553444378',
  unitPolicy: 'd8906ca5c7ba124a0407a32dab37b2c82b13b3dcd9111e42940dcea4',
  unitName: '5553444378',
  legCarrier: 2_500_000n,
  liqwidHash: 'b94e42c56ad25c04a0a047d4f04e257193fc8a3914495a6de75da926',
  fxFeed: ADA_USD_PREVIEW,
  fxScale: 1_000_000n,
  rates: [
    {
      policy: '4c7cebfb861d35028b3e592d40d7b8de4edc4f7ffe6998f1cf46f529',
      name: '',
      statePolicy: 'a105d84b0a59ce79a155ce99933b6ee9d942d390d8abe97b3516a5c3',
      stateName: '',
      stateScript: '7ab46d57e607f4e18990c12d7bc060aeb846a915cc812696e9e2fc47',
      floor: ['5553444358', '55534443', '4c4951574944'],
      liqDiv: 10n,
    },
  ],
  rows: [
    { feed: ADA_USD_PREVIEW, class: 0, kind: 0, sheet: BARRIER_SHEET_PREVIEW },
    { feed: USDT_USD_PREVIEW, class: 1, kind: 0, sheet: STABLE_SHEET_PREVIEW },
  ],
  positionHash: '2c7e04ff848e684df95ce990f0becad0e891eea4b0e5d9e5b1610534',
  bookHash: 'b52e2dbcbccf5883431167c8af0abc85356db3d3e0adc31a00d6c25b',
  tableHash: '99f4c22238e4c6ec481ba2f364dd2e72612a9857f54fd7c5a68f8d4f',
  tableName: '41454749535f424f4f4b5f5441424c45',
  accrualHash: '0457b39838e82e70bb0672860face954ce1c8c99d71591316ae43f30',
  observerHash: '8f5b93aefb8f471f19128ab92e56d04b2435e9f88bcdfd35238211c8',
  beaconPolicy: 'b3083a9db61f5d86136927d9d1f958fd452edc5bc22783cb07ef4fa7',
  beaconName: '41454749535f424f4f4b5f4c414e45',
  treasury: G3_PREVIEW_ADA.treasury,
  publisherVkh: 'f4b09d9bd4226de67e6ac6b2352554d4d4aa7e405e1efcc1f54b3903',
  feeBps: 200n,
  donationBps: 50n,
  minPremium: 10_000_000n,
  minLegPremium: 1_000_000n,
  minLegCoverage: 2_000_000n,
  maxLegs: 10,
  heads: [0, 1, 2, 3].map((i) => `3be298838d79087796fcd0df8e5b9c3e2054da864e4e15bbfd9fc0f3b4843652#${i}`),
  refScripts: {
    position: '57463c1df54b4bc6ee4d3b81d611545bdc31c41a9ed8be854f170e8159eee9c4#0',
    book: 'ae24890fcd3721341dd93b0dc66e74610070c147fc3773b33647a443fad3472d#0',
    observer: '9de2148efb27ee18e4c169566860c92928dfcf097c1349549ad74c4d810fc222#0',
    accrual: '0b3f28848b6b718b083b44f1cc8f7b95fe196e9c484f44c010bd22a3a89f0c20#0',
    table: 'bcb0f8aeadd54638dd349ba7917ced75aaaa7c8cb405b88404527c209b0a4de6#0',
    liqwid: '917bece2234dc6b0fdc60243372b80772552c91e21860c68f45fc1aac994c383#0',
  },
  sheets: {
    [BARRIER_SHEET_PREVIEW]: G3_PREVIEW_ADA.sheets[BARRIER_SHEET_PREVIEW],
    [STABLE_SHEET_PREVIEW]: G3_PREVIEW_ADA.sheets[STABLE_SHEET_PREVIEW],
  },
};

/** The gen-3 instances each network has launched, by name. */
export const G3_INSTANCES: Readonly<Partial<Record<Network, Readonly<Record<string, G3Instance>>>>> = {
  preview: { ada: G3_PREVIEW_ADA, usdcx: G3_PREVIEW_USDCX },
};

export const G3_BARRIER = 0;
export const G3_DEPEG = 1;
/** How long the API holds a quoted request's funding once prepared. */
export const G3_QUOTE_VALIDITY_MS = 90_000;
/** The widest span a sale's validity range may have. */
export const G3_MAX_UNDERWRITE_SPAN_MS = 1_200_000n;
/** How old the spot may be at the policy's start, by class. */
export const G3_MAX_SPOT_AGE_MS: Readonly<Record<number, bigint>> = { 0: 600_000n, 1: 300_000n };
/** The least lovelace a leg holds. */
export const G3_MIN_LEG_LOVELACE = 2_000_000n;

const P_PREFIX = '50';
const C_PREFIX = '43';
const BPS = 10_000n;
const AEGIS_SELF = 2;
const WIDEST_UINT = 2n ** 64n - 1n;

/** A cover request exactly as the API's routes read and hash it. */
export interface G3CoverRequest {
  /** The insured's payment key hash: the key that signs the reservation and the sale. */
  insured: string;
  /** The oracle feed's policy. */
  feed: string;
  class: number;
  strike: bigint;
  coverage: bigint;
  term_ms: bigint;
  premium: bigint;
  /** The P-leg's lovelace: g3PLegDeposit's answer. */
  deposit: bigint;
  /** The wallet UTxOs the sale may spend, as "txid#index". */
  funding: string[];
  collateral: string[];
  lane: number;
  ttl_ms: number;
  transport_cap: null;
  /** Where the cover pays: the insured's own staked address (g3PayoutOf), or null for the insured key alone. */
  payout_address: G3AddressView | null;
  saturn_order: null;
  /** The receipt a receipt-backed sale pins, or null. */
  pin: G3ReceiptPin | null;
}

/** A credential as the API's JSON names it. */
export type G3Credential = { key: string } | { script: string };

/** An address as the API's JSON names it: a payment credential and a stake part, a pointer or none. */
export interface G3AddressView {
  payment: G3Credential;
  stake: G3Credential | { pointer: number[] } | null;
}

export interface G3Quote {
  unit: string;
  available: boolean;
  legs: number;
  coverage: bigint;
  premium: bigint;
  loadedAsk: bigint;
  pricedBy: string | null;
  protocolFee: bigint;
  feeLovelace: bigint;
  donationLovelace: bigint;
  /** What the buyer pays in the unit and in lovelace beside it, the deposit among it. */
  needs: { unit: bigint; lovelace: bigint };
  fx: bigint | null;
  carriers: bigint;
  validForMs: number;
  /** The API's answer as it came. */
  answer: unknown;
}

/** What prepare presents: the reservation holding the funding and the sale's unsigned bytes. */
export interface G3Prepared {
  reservation: string;
  cbor: string;
}

/** CIP-30 signData's answer: COSE_Sign1 and COSE_Key, hex. */
export interface DataSignature {
  signature: string;
  key: string;
}

export interface BookApiOptions {
  /** The Aegis API's base URL. */
  baseUrl: string;
  /** Override fetch (default: globalThis.fetch). */
  fetchImpl?: MinimalFetch;
}

/** A refusal the Book API answered with, its own code kept. */
export class BookRefusal extends AegisError {
  readonly refusal: string;
  readonly detail: unknown;

  constructor(refusal: string, detail: unknown) {
    super('pool', 'BOOK_REFUSED', `${refusal}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    this.name = 'BookRefusal';
    this.refusal = refusal;
    this.detail = detail;
  }
}

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', message);
}

// --- the request ----------------------------------------------------------------------

function jsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function pythonJson(value: unknown, sortKeys: boolean): string {
  const write = (v: unknown) => pythonJson(v, sortKeys);
  if (value === null) return 'null';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse(`canonical JSON writes whole numbers only, not ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return jsonString(value);
  if (Array.isArray(value)) return `[${value.map(write).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    if (sortKeys) keys.sort();
    return `{${keys.map((k) => `${jsonString(k)}:${write((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return refuse(`canonical JSON has no form for a ${typeof value}`);
}

/**
 * JSON as Python's json.dumps(sort_keys=True, separators=(",", ":")) writes it: keys sorted,
 * no whitespace, non-ASCII escaped, a bigint as its integer. The API hashes a request in this
 * form, so a client must write it byte for byte.
 */
export function canonicalJson(value: unknown): string {
  return pythonJson(value, true);
}

/** JSON as Python's json.dumps(separators=(",", ":")) writes it: canonicalJson with each object's keys in their own order. */
export function compactJson(value: unknown): string {
  return pythonJson(value, false);
}

/** The request's hash the reservation names: blake2b-256 of its canonical JSON. */
export function g3RequestHash(request: G3CoverRequest): string {
  return bytesToHex(blake2b(asciiBytes(canonicalJson(request)), 32));
}

/** The bytes of canonical JSON, which escapes every character past ASCII. */
function asciiBytes(json: string): Uint8Array {
  return Uint8Array.from(json, (c) => c.charCodeAt(0));
}

/**
 * The text the insured's wallet signs with CIP-30 signData (its UTF-8 bytes, hex, as the
 * payload) to reserve the request's funding: the UTxOs it names, the request's hash, the lane
 * and how long the reservation holds.
 */
export function g3ReservationPayload(request: G3CoverRequest): string {
  const utxos = [...new Set([...request.funding, ...request.collateral])].sort();
  return canonicalJson({ utxos, request: g3RequestHash(request), lane: request.lane, ttl_ms: request.ttl_ms });
}

// --- the API --------------------------------------------------------------------------

/**
 * POST `body` as canonical JSON to an Aegis Book route for the instance and answer its JSON;
 * any other answer is a BookRefusal under the route's code, or refused-<status> without one.
 */
export async function bookPost(api: BookApiOptions, instance: G3Instance, path: string, body: unknown): Promise<any> {
  const f: MinimalFetch | undefined = api.fetchImpl ?? (globalThis as { fetch?: MinimalFetch }).fetch;
  if (!f) refuse('no fetch available: pass fetchImpl');
  const query = `network=${encodeURIComponent(instance.network)}&unit=${encodeURIComponent(instance.unit)}`;
  const res = await f(`${api.baseUrl.replace(/\/+$/, '')}${path}?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: canonicalJson(body),
  });
  let answer: any;
  let parsed = true;
  if (typeof res.text === 'function') {
    const text = await res.text();
    try {
      answer = JSON.parse(text);
    } catch {
      parsed = false;
      answer = text.slice(0, 500);
    }
  } else {
    answer = await res.json().catch(() => {
      parsed = false;
      return '';
    });
  }
  if (!res.ok || !parsed) {
    const detail = parsed ? (answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer.detail ?? null : null) : answer;
    const code = detail !== null && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.code === 'string' && detail.code
      ? detail.code
      : `refused-${res.status}`;
    throw new BookRefusal(code, detail);
  }
  return answer;
}

function whole(x: unknown, what: string): bigint {
  if (typeof x !== 'number' || !Number.isSafeInteger(x)) refuse(`the quote's ${what} is not a whole number`);
  return BigInt(x);
}

function quoteOf(a: any): G3Quote {
  if (typeof a !== 'object' || a === null || typeof a.available !== 'boolean' || typeof a.needs !== 'object') {
    refuse('the quote answer is not a quote');
  }
  return {
    unit: String(a.unit),
    available: a.available,
    legs: Number(whole(a.legs, 'legs')),
    coverage: whole(a.coverage, 'coverage'),
    premium: whole(a.premium, 'premium'),
    loadedAsk: whole(a.loaded_ask, 'loaded_ask'),
    pricedBy: a.priced_by === null ? null : String(a.priced_by),
    protocolFee: whole(a.protocol_fee, 'protocol_fee'),
    feeLovelace: whole(a.fee_lovelace, 'fee_lovelace'),
    donationLovelace: whole(a.donation_lovelace, 'donation_lovelace'),
    needs: { unit: whole(a.needs.unit, 'needs.unit'), lovelace: whole(a.needs.lovelace, 'needs.lovelace') },
    fx: a.fx === null ? null : whole(a.fx, 'fx'),
    carriers: whole(a.carriers, 'carriers'),
    validForMs: Number(whole(a.valid_for_ms, 'valid_for_ms')),
    answer: a,
  };
}

/** What the Book would sell the request for, reserving nothing. Refuses cover the Book cannot sell whole. */
export async function quoteG3Cover(api: BookApiOptions, instance: G3Instance, request: G3CoverRequest): Promise<G3Quote> {
  const quote = quoteOf(await bookPost(api, instance, '/api/book/g3/quote', request));
  if (!quote.available) {
    throw new BookRefusal('cover-unavailable', `the book sells ${quote.coverage} of the ${request.coverage} asked`);
  }
  return quote;
}

/**
 * Reserve the request's funding and have the API present the sale. `signatures` maps the
 * insured's key hash to its wallet's signData answer over g3ReservationPayload(request).
 */
export async function prepareG3Cover(
  api: BookApiOptions,
  instance: G3Instance,
  request: G3CoverRequest,
  signatures: Record<string, DataSignature>,
): Promise<G3Prepared> {
  const answer = await bookPost(api, instance, '/api/book/g3/prepare', { request, signatures });
  if (typeof answer?.reservation !== 'string' || typeof answer?.cbor !== 'string') {
    refuse('the prepare answer carries no reservation and sale bytes');
  }
  return { reservation: answer.reservation, cbor: answer.cbor };
}

/**
 * Add the wallet's signTx witness set to the prepared sale and submit it under its
 * reservation. Returns the transaction id, refusing an answer that names another.
 */
export async function submitG3Sale(
  api: BookApiOptions,
  instance: G3Instance,
  prepared: G3Prepared,
  witnessSet: string,
): Promise<string> {
  const signed = spliceVkeyWitnesses(prepared.cbor, witnessSet);
  const id = transactionId(signed);
  const answer = await bookPost(api, instance, '/api/book/g3/submit', { reservation: prepared.reservation, cbor: signed });
  if (answer?.tx !== id) throw new BookRefusal('submit-answered-another-tx', `the API answered ${answer?.tx} for ${id}`);
  return id;
}

// --- datums ---------------------------------------------------------------------------

/** The position digest a Head names: blake2b-224 of its OutputReference as serialiseData writes it. */
export function g3Digest(headRef: string): string {
  const m = /^([0-9a-f]{64})#(0|[1-9][0-9]*)$/.exec(headRef);
  if (!m) refuse(`${headRef} is not txid#index`);
  return outRefDigest(hexToBytes(m[1]), BigInt(m[2]));
}

/** The digest as the inline datum the fee and accrual outputs carry. */
export function g3DigestDatum(digest: string): string {
  return bytesToHex(encodePlutusData(hexToBytes(digest)));
}

const NONE: PlutusData = { constructor: 1, fields: [] };

/** The fields of a gen-3 P-leg's PolicyDatum a sale writes. */
export interface G3PolicyTerms {
  digest: string;
  insured: string;
  strike: bigint;
  coverage: bigint;
  premium: bigint;
  startMs: bigint;
  expiryMs: bigint;
  feed: string;
  class: number;
  /** The payout address the policy commits; none pays the insured key alone. */
  payout?: G3AddressView | null;
  /** The receipt a pinned sale writes into the extension. */
  pin?: G3ReceiptPin | null;
}

function credentialData(c: G3Credential): PlutusData {
  return 'key' in c ? { constructor: 0, fields: [hexToBytes(c.key)] } : { constructor: 1, fields: [hexToBytes(c.script)] };
}

/** An address view as Plutus Data, as the routes write a payout address. */
export function g3AddressData(view: G3AddressView): PlutusData {
  const stake = view.stake;
  const staked: PlutusData = stake === null
    ? NONE
    : 'pointer' in stake
      ? { constructor: 0, fields: [{ constructor: 1, fields: stake.pointer.map(BigInt) }] }
      : { constructor: 0, fields: [{ constructor: 0, fields: [credentialData(stake)] }] };
  return { constructor: 0, fields: [credentialData(view.payment), staked] };
}

/** A ReceiptPin as serialiseData writes it, the form a pinned policy's extension carries. */
export function g3ReceiptPinCbor(pin: G3ReceiptPin): Uint8Array {
  return encodeConstr(0, [encodeBytes(hexToBytes(pin.policy)), encodeBytes(hexToBytes(pin.name))]);
}

/**
 * The P-leg's PolicyDatum: AegisSelf, no partner, the committed payout address, no pins, and
 * the receipt pin, if any, in the extension.
 */
export function g3PolicyDatum(terms: G3PolicyTerms, instance: G3Instance): Uint8Array {
  const b = (h: string) => hexToBytes(h);
  const fields: PlutusData[] = [
    b(terms.digest), b(terms.insured), terms.strike, terms.coverage, terms.premium, terms.startMs, terms.expiryMs,
    b(terms.feed), b(instance.positionHash), b(instance.beaconPolicy), { constructor: AEGIS_SELF, fields: [] },
    NONE, 0n, { constructor: terms.class, fields: [] },
    terms.payout ? { constructor: 0, fields: [g3AddressData(terms.payout)] } : NONE, NONE, NONE, NONE,
  ];
  const extension = terms.pin ? concat([SOME_HEAD, g3ReceiptPinCbor(terms.pin)]) : encodePlutusData(NONE);
  return concat([CONSTR_0_OF_19, ...fields.map(encodePlutusData), extension]);
}

const CONSTR_0_OF_19 = new Uint8Array([0xd8, 0x79, 0x93]);
const SOME_HEAD = new Uint8Array([0xd8, 0x79, 0x81]);

/** A P-leg's PolicyDatum as the position validator reads it. */
export interface G3PolicyDatum extends Omit<G3PolicyTerms, 'payout' | 'pin'> {
  poolScriptHash: string;
  poolNft: string;
  provider: number;
  partnerAddress: PlutusData | null;
  partnerShareBps: bigint;
  payoutAddress: PlutusData | null;
  receiptCommitment: PlutusData | null;
  payoutDatum: PlutusData | null;
  settlementPins: PlutusData | null;
  extension: PlutusData | null;
  /** Fields past the nineteenth. */
  tail: number;
}

function option(node: PlutusData, what: string): PlutusData | null {
  const c = constrOf(node, what);
  if (c.constructor === 1 && c.fields.length === 0) return null;
  if (c.constructor === 0 && c.fields.length === 1) return c.fields[0];
  return refuse(`${what} is no Option`);
}

function unit(node: PlutusData, what: string): number {
  const c = constrOf(node, what);
  if (c.fields.length !== 0) refuse(`${what} carries fields`);
  return c.constructor;
}

export function decodeG3PolicyDatum(cbor: string | Uint8Array): G3PolicyDatum {
  const c = constrOf(decodePlutusData(cbor), 'a PolicyDatum');
  if (c.constructor !== 0 || c.fields.length < 19) refuse('a PolicyDatum is constructor 0 of at least nineteen fields');
  const f = c.fields;
  return {
    digest: dataHex(f[0], 'policy_id'),
    insured: dataHex(f[1], 'insured'),
    strike: dataInt(f[2], 'strike_price'),
    coverage: dataInt(f[3], 'coverage_amount'),
    premium: dataInt(f[4], 'premium_paid'),
    startMs: dataInt(f[5], 'start_time'),
    expiryMs: dataInt(f[6], 'expiry_time'),
    feed: dataHex(f[7], 'oracle_nft'),
    poolScriptHash: dataHex(f[8], 'pool_script_hash'),
    poolNft: dataHex(f[9], 'pool_nft'),
    provider: unit(f[10], 'oracle_provider'),
    partnerAddress: option(f[11], 'partner_address'),
    partnerShareBps: dataInt(f[12], 'partner_share_bps'),
    class: unit(f[13], 'risk_class'),
    payoutAddress: option(f[14], 'payout_address'),
    receiptCommitment: option(f[15], 'receipt_commitment'),
    payoutDatum: option(f[16], 'payout_datum'),
    settlementPins: option(f[17], 'settlement_pins'),
    extension: option(f[18], 'extension'),
    tail: f.length - 19,
  };
}

/** A leg's datum: whose capital it is, the cover and premium it carries, the offer it came from and its position. */
export interface G3LegDatum {
  owner: { kind: 'key' | 'script'; hash: string };
  coverage: bigint;
  premium: bigint;
  source: string;
  digest: string;
}

export function decodeG3LegDatum(cbor: string | Uint8Array): G3LegDatum {
  const [owner, coverage, premium, source, digest] = fieldsOf(decodePlutusData(cbor), 'a LegDatum', 5);
  const cred = constrOf(owner, 'the leg owner');
  if (cred.constructor > 1 || cred.fields.length !== 1) refuse('the leg owner is no credential');
  const [tx, ix] = fieldsOf(source, 'the leg source', 2);
  return {
    owner: { kind: cred.constructor === 0 ? 'key' : 'script', hash: dataHex(cred.fields[0], 'the leg owner') },
    coverage: dataInt(coverage, 'the leg coverage'),
    premium: dataInt(premium, 'the leg premium'),
    source: `${dataHex(tx, 'the leg source tx')}#${dataInt(ix, 'the leg source index')}`,
    digest: dataHex(digest, 'the leg position'),
  };
}

/** An AegisSelf feed reading. */
export interface FeedReading {
  spot: bigint;
  observedAt: bigint;
  validUntil: bigint;
  min12h: bigint;
  lowAt: bigint;
}

/** An AegisSelf feed datum: keys 0-2 required, the twelve-hour low defaulting to the spot and its time to 0. */
export function decodeFeedReading(cbor: string | Uint8Array): FeedReading {
  const [inner] = fieldsOf(decodePlutusData(cbor), 'a feed datum', 1);
  const prices = constrOf(inner, 'the feed prices');
  if (prices.constructor !== 2 || prices.fields.length !== 1) refuse('the feed prices are not AegisSelf');
  const m = prices.fields[0];
  if (typeof m !== 'object' || m instanceof Uint8Array || Array.isArray(m) || !('map' in m)) refuse('the feed prices are no map');
  const entries = m.map;
  const at = (k: bigint): bigint | undefined => {
    const hit = entries.find(([key]) => key === k);
    return hit === undefined ? undefined : dataInt(hit[1], `price key ${k}`);
  };
  const spot = at(0n);
  const observedAt = at(1n);
  const validUntil = at(2n);
  if (spot === undefined || observedAt === undefined || validUntil === undefined) {
    refuse('a feed datum carries keys 0, 1 and 2');
  }
  return { spot, observedAt, validUntil, min12h: at(3n) ?? spot, lowAt: at(4n) ?? 0n };
}

// --- outputs the chain holds -------------------------------------------------------

/** An output a transaction spends or references, as the chain holds it. */
export interface ResolvedOutput extends Omit<TxOutput, 'scriptRef'> {
  referenceScript: { hash: string; size: number } | null;
}

/** Koios utxo_info rows (`_extended`) as resolved outputs keyed "txid#index". */
export function resolvedOutputsFromKoios(rows: KoiosUtxo[]): Record<string, ResolvedOutput> {
  const out: Record<string, ResolvedOutput> = {};
  for (const r of rows) {
    if (typeof r.address !== 'string') refuse(`Koios row ${r.tx_hash}#${r.tx_index} carries no address`);
    const assets: Assets = {};
    for (const a of r.asset_list ?? []) {
      assets[a.policy_id] ??= {};
      assets[a.policy_id][a.asset_name ?? ''] = BigInt(a.quantity);
    }
    out[`${r.tx_hash}#${r.tx_index}`] = {
      address: bytesToHex(addressBytes(r.address)),
      lovelace: BigInt(r.value),
      assets,
      datum: r.inline_datum
        ? { kind: 'inline', cbor: r.inline_datum.bytes }
        : r.datum_hash
          ? { kind: 'hash', hash: r.datum_hash }
          : null,
      referenceScript: r.reference_script ? { hash: r.reference_script.hash, size: r.reference_script.size } : null,
    };
  }
  return out;
}

/** Every output `refs` names, read from Koios; refuses one Koios does not hold. */
export async function readResolvedOutputs(refs: string[], opts: KoiosReadOptions): Promise<Record<string, ResolvedOutput>> {
  const named = [...new Set(refs)];
  const resolved = resolvedOutputsFromKoios(await koiosUtxos(opts, 'utxo_info', { _utxo_refs: named, _extended: true }));
  const missing = named.filter((r) => !(r in resolved));
  if (missing.length) refuse(`Koios holds no ${missing.join(', ')}`);
  return resolved;
}

/** Every output a transaction spends, puts up as collateral or references. */
export function outputsNamedBy(tx: DecodedTransaction): string[] {
  return [...new Set([...tx.inputs, ...tx.collateral, ...tx.referenceInputs])];
}

// --- sizing -------------------------------------------------------------------------

function scriptAddress(hash: string, network: Network): string {
  return addressHex({ payment: { kind: 'script', hash: hexToBytes(hash) }, stake: null }, CHAIN_FACTS[network].networkId);
}

function datumHex(cbor: Uint8Array): { kind: 'inline'; cbor: string } {
  return { kind: 'inline', cbor: bytesToHex(cbor) };
}

/**
 * The least deposit whose P-leg clears min-UTxO for any allocation the API could build for
 * `request`: coverage, premium, start and expiry at their widest encodings.
 */
export function g3PLegDeposit(request: G3CoverRequest, instance: G3Instance, params: ProtocolParams): bigint {
  const terms: G3PolicyTerms = {
    digest: '00'.repeat(28), insured: request.insured, strike: request.strike, coverage: WIDEST_UINT,
    premium: WIDEST_UINT, startMs: WIDEST_UINT - request.term_ms, expiryMs: WIDEST_UINT, feed: request.feed,
    class: request.class, payout: request.payout_address, pin: request.pin,
  };
  return minUtxo(
    {
      address: scriptAddress(instance.positionHash, instance.network),
      lovelace: 0n,
      assets: { [instance.positionHash]: { [P_PREFIX + terms.digest]: 1n } },
      datum: datumHex(g3PolicyDatum(terms, instance)),
      scriptRef: null,
    },
    params,
  );
}

/** The fee output's lovelace on the ADA instance: the rate on the premium, floored at its own min-UTxO. */
export function g3ProtocolFee(premium: bigint, instance: G3Instance, params: ProtocolParams): bigint {
  const rate = ceil(premium * instance.feeBps, BPS);
  const floor = minUtxo(
    { address: instance.treasury, lovelace: rate, assets: {}, datum: { kind: 'inline', cbor: g3DigestDatum('00'.repeat(28)) }, scriptRef: null },
    params,
  );
  return rate > floor ? rate : floor;
}

/** The least Treasury donation the position validator takes for `premium` on the ADA instance. */
export function g3Donation(premium: bigint, instance: G3Instance): bigint {
  return ceil(premium * instance.donationBps, BPS);
}

function ceil(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

const DAY_MS = 86_400_000n;
const CELL_BYTES = 11;

/** How far below the effective spot, the lower of spot and twelve-hour low, the strike stands, in bps. */
export function g3DepthBps(reading: FeedReading, strike: bigint): bigint {
  const spot = reading.min12h < reading.spot ? reading.min12h : reading.spot;
  if (spot <= 0n) refuse('the reading has no positive spot');
  const d = (spot - strike) * BPS;
  return d >= 0n ? d / spot : -((-d + spot - 1n) / spot);
}

/**
 * The sheet cell an offer prices a sale at: the first of its 11-byte cells (class, min and max
 * depth bps, min and max days, rate bps) whose class, depth band and day band take the sale.
 */
export function g3SheetCell(
  sheetDatum: string,
  sale: { class: number; depthBps: bigint; termMs: bigint },
): { cell: number; rateBps: bigint } {
  const asks = decodePlutusData(sheetDatum);
  if (!(asks instanceof Uint8Array) || asks.length % CELL_BYTES !== 0) refuse('a sheet is a bytestring of 11-byte cells');
  const u16 = (at: number) => BigInt((asks[at] << 8) | asks[at + 1]);
  for (let cell = 0; cell * CELL_BYTES < asks.length; cell++) {
    const base = cell * CELL_BYTES;
    if (
      asks[base] === sale.class && u16(base + 1) <= sale.depthBps && sale.depthBps <= u16(base + 3) &&
      u16(base + 5) * DAY_MS <= sale.termMs && sale.termMs <= u16(base + 7) * DAY_MS
    ) {
      return { cell, rateBps: u16(base + 9) };
    }
  }
  return refuse(`the sheet has no cell for class ${sale.class} at ${sale.depthBps} bps over ${sale.termMs} ms`);
}

/**
 * A leg's least premium the validator takes: its loaded ask, its share of the Book minimum,
 * a fiftieth of its coverage and the instance's least leg premium, whichever is highest.
 */
export function g3LegPremium(
  leg: { coverage: bigint; totalCoverage: bigint; rateBps: bigint; loadBps: bigint },
  instance: G3Instance,
): bigint {
  const floors = [
    ceil(leg.coverage * leg.rateBps * (BPS + leg.loadBps), 100_000_000n),
    ceil(instance.minPremium * leg.coverage, leg.totalCoverage),
    ceil(leg.coverage, 50n),
    instance.minLegPremium,
  ];
  return floors.reduce((a, b) => (a > b ? a : b));
}

// --- the judgement --------------------------------------------------------------------

export interface G3SaleProblem {
  /** The family of departure, stable across releases. */
  code: string;
  /** The one condition that failed. */
  conjunct: string;
  detail: string;
}

export interface VerifyG3SaleInput {
  /** The sale's bytes as prepare presented them. */
  tx: string | Uint8Array;
  request: G3CoverRequest;
  quote: G3Quote;
  instance: G3Instance;
  /** The chain's own reads of every output the sale spends, puts up or references. */
  resolved: Record<string, ResolvedOutput>;
  params: ProtocolParams;
}

interface Credential {
  kind: 'key' | 'script';
  hash: string;
}

function credentialsOf(addressHex: string): { payment: Credential | null; stake: Credential | null; networkId: number | null } {
  const header = parseInt(addressHex.slice(0, 2), 16);
  const type = header >> 4;
  if (type > 7) return { payment: null, stake: null, networkId: null };
  const payment: Credential = { kind: type & 1 ? 'script' : 'key', hash: addressHex.slice(2, 58) };
  const stake: Credential | null = type < 4 ? { kind: type & 2 ? 'script' : 'key', hash: addressHex.slice(58, 114) } : null;
  return { payment, stake, networkId: header & 0x0f };
}

function samePayout(committed: PlutusData | null, asked: G3AddressView | null): boolean {
  if (committed === null || asked === null) return committed === asked;
  return bytesToHex(encodePlutusData(committed)) === bytesToHex(encodePlutusData(g3AddressData(asked)));
}

function quantity(assets: Assets, policy: string, name: string): bigint {
  return assets[policy]?.[name] ?? 0n;
}

function onlyAsset(assets: Assets, policy: string, name: string): boolean {
  const policies = Object.keys(assets).filter((p) => Object.values(assets[p]).some((q) => q !== 0n));
  return policies.length === 1 && policies[0] === policy && quantity(assets, policy, name) === 1n &&
    Object.values(assets[policy]).filter((q) => q !== 0n).length === 1;
}

function markerOf(assets: Assets, position: string, prefix: string): string | null {
  const names = Object.entries(assets[position] ?? {}).filter(([n, q]) => q === 1n && n.startsWith(prefix));
  return names.length === 1 ? names[0][0] : null;
}

function tryDecode<T>(read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    if (e instanceof InputError) return null;
    throw e;
  }
}

/** The fee of a transaction at the maximum size and the maximum units. */
export function maxFee(params: ProtocolParams): bigint {
  const [mn, md] = params.priceMem;
  const [sn, sd] = params.priceSteps;
  return params.minFeeA * BigInt(params.maxTxSize) + params.minFeeB +
    ceil(params.maxTxMem * mn * sd + params.maxTxSteps * sn * md, md * sd);
}

/**
 * Why the buyer must not sign the presented sale; empty when every check holds. Judged on
 * `resolved`, the buyer's own reads of the chain, never on what the API says about it.
 */
export function verifyG3Sale(input: VerifyG3SaleInput): G3SaleProblem[] {
  const { request, quote, instance: inst, resolved, params } = input;
  if (inst.unit !== 'lovelace') refuse('verifyG3Sale judges sales of the ADA instance');
  const tx = decodeTransaction(input.tx);
  const problems: G3SaleProblem[] = [];
  const fail = (code: string, conjunct: string, detail: string) => problems.push({ code, conjunct, detail });
  const network = CHAIN_FACTS[inst.network].networkId;
  const position = inst.positionHash;
  const positionAddress = scriptAddress(position, inst.network);

  if (tx.vkeyWitnesses.length) fail('sale-already-witnessed', 'vkey-witness-present', 'the bytes already carry a witness');

  for (const o of [...tx.outputs, ...(tx.collateralReturn ? [tx.collateralReturn] : [])]) {
    const id = credentialsOf(o.address).networkId;
    if (id !== null && id !== network) fail('sale-off-the-network', 'output-network', `an output pays network ${id}`);
  }
  if (tx.withdrawals.some((w) => w.networkId !== network)) fail('sale-off-the-network', 'withdrawal-network', 'a withdrawal is from another network');
  if (tx.networkId !== null && tx.networkId !== network) fail('sale-off-the-network', 'body-network', `the body names network ${tx.networkId}`);

  const tables = tx.referenceInputs.filter((r) => {
    const o = resolved[r];
    return o && credentialsOf(o.address).payment?.hash === inst.tableHash && quantity(o.assets, inst.tableHash, inst.tableName) === 1n;
  });
  if (tables.length !== 1) fail('table-not-referenced', 'one-table', `${tables.length} references hold the instance's table`);

  // The P-leg, its digest and the Head it names.
  const head = tx.inputs.find((r) => resolved[r] && quantity(resolved[r].assets, inst.beaconPolicy, inst.beaconName) === 1n);
  const digest = head ? g3Digest(head) : null;
  const pAt = tx.outputs.findIndex((o) => markerOf(o.assets, position, P_PREFIX) !== null);
  const pOut = pAt >= 0 ? tx.outputs[pAt] : null;
  const pd = pOut?.datum?.kind === 'inline' ? tryDecode(() => decodeG3PolicyDatum((pOut.datum as { cbor: string }).cbor)) : null;
  const mintedHere = tx.mint[position] ?? {};
  if (!digest) fail('p-leg-not-at-the-position', 'head-not-spent', 'no spent input holds the lanes beacon');
  if (!digest || Object.keys(mintedHere).length !== 2 || mintedHere[P_PREFIX + digest] !== 1n || mintedHere[C_PREFIX + digest] === undefined) {
    fail('p-leg-not-at-the-position', 'markers-not-the-heads', 'the position policy mints no P and C markers of the spent Head');
  }
  if (!pOut || markerOf(pOut.assets, position, P_PREFIX) !== P_PREFIX + digest) {
    fail('p-leg-not-at-the-position', 'p-leg-without-the-p-marker', "no output holds the Head's P marker");
  }
  if (pOut && pOut.address !== positionAddress) {
    fail('p-leg-not-at-the-position', 'p-leg-off-the-position-address', 'the P-leg is not at Script(position), no stake');
  }
  if (head) {
    const h = resolved[head];
    const kept = tx.outputs.some(
      (o) => o.address === h.address && o.datum === null && o.scriptRef === null &&
        onlyAsset(o.assets, inst.beaconPolicy, inst.beaconName) && o.lovelace >= h.lovelace,
    );
    if (!kept) fail('p-leg-not-at-the-position', 'beacon-kept-from-its-head', 'no Head continuation carries the lanes beacon');
  }
  if (!pd) fail('p-leg-not-at-the-position', 'p-leg-datum-unreadable', 'the P-leg carries no readable PolicyDatum');

  // The policy against the request.
  if (pd) {
    const checks: Array<[string, boolean]> = [
      ['insured-key', pd.insured === request.insured && tx.requiredSigners.includes(request.insured)],
      ['feed', pd.feed === request.feed],
      ['class', pd.class === request.class],
      ['strike', pd.strike === request.strike],
      ['coverage', pd.coverage === request.coverage],
      ['term', pd.expiryMs - pd.startMs === request.term_ms],
      ['payout-address', samePayout(pd.payoutAddress, request.payout_address)],
    ];
    for (const [name, ok] of checks) if (!ok) fail('insured-not-the-buyer', name, `the P-leg's ${name} is not the request's`);
    const pins: Array<[string, boolean]> = [
      ['policy-id-not-the-digest', pd.digest === digest],
      ['provider-not-aegis-self', pd.provider === AEGIS_SELF],
      ['partner', pd.partnerAddress === null && pd.partnerShareBps === 0n],
      ['receipt-commitment', pd.receiptCommitment === null],
      ['payout-datum', pd.payoutDatum === null],
      ['settlement-pins', pd.settlementPins === null],
      ['extension', pd.extension === null && pd.tail === 0],
      ['pool-not-the-instance', pd.poolNft === inst.beaconPolicy && pd.poolScriptHash === position],
    ];
    for (const [name, ok] of pins) if (!ok) fail('p-leg-off-the-core-pins', name, `the P-leg is off the core pin ${name}`);
  }

  // The legs.
  const legs = tx.outputs
    .map((o, at) => ({ o, at }))
    .filter(({ o }) => credentialsOf(o.address).payment?.kind === 'script' && credentialsOf(o.address).payment?.hash === position &&
      markerOf(o.assets, position, C_PREFIX) !== null);
  if (legs.length === 0) fail('p-leg-not-at-the-position', 'no-leg', 'no output is a leg of the position');
  let premium = 0n;
  for (const { o, at } of legs) {
    const leg = o.datum?.kind === 'inline' ? tryDecode(() => decodeG3LegDatum((o.datum as { cbor: string }).cbor)) : null;
    if (!leg || leg.digest !== digest || markerOf(o.assets, position, C_PREFIX) !== C_PREFIX + digest) {
      fail('p-leg-not-at-the-position', 'leg-not-of-the-position', `output ${at} is no leg of this position`);
      continue;
    }
    premium += leg.premium;
    if (o.lovelace < G3_MIN_LEG_LOVELACE) fail('leg-under-the-min-utxo', 'leg-under-two-ada', `leg ${at} holds ${o.lovelace}`);
  }
  if (legs.length > inst.maxLegs) fail('p-leg-not-at-the-position', 'legs-over-the-max', `${legs.length} legs, over ${inst.maxLegs}`);

  // The buyer.
  const buyerAddresses = new Set(request.funding.filter((r) => resolved[r]).map((r) => resolved[r].address));
  const payments = new Set([request.insured]);
  const stakes = new Set<string>();
  for (const r of request.funding) {
    if (!resolved[r]) continue;
    const c = credentialsOf(resolved[r].address);
    if (c.payment) payments.add(c.payment.hash);
    if (c.stake) stakes.add(c.stake.hash);
  }
  const buyerCreds = new Set([...payments, ...stakes]);
  const named = new Set([...request.funding, ...request.collateral]);

  for (const r of tx.collateral) {
    const o = resolved[r];
    if (!named.has(r) || !o) fail('collateral-not-the-buyers', 'collateral-not-named', `collateral ${r} is not a named UTxO`);
    else if (Object.keys(o.assets).length) fail('collateral-not-the-buyers', 'collateral-holds-a-token', `collateral ${r} holds a token`);
    else if (o.referenceScript) fail('collateral-not-the-buyers', 'collateral-holds-a-reference-script', `collateral ${r} holds a reference script`);
  }
  if (tx.collateralReturn && !buyerAddresses.has(tx.collateralReturn.address)) {
    fail('collateral-not-the-buyers', 'collateral-return-off-the-buyer', 'the collateral return is not a buyer address');
  }
  if (tx.collateral.length && tx.totalCollateral === null) {
    fail('collateral-not-the-buyers', 'total-collateral-absent', 'the body states no total collateral');
  } else if (tx.totalCollateral !== null && tx.totalCollateral > requiredCollateral(tx.fee, params)) {
    fail('collateral-not-the-buyers', 'total-collateral-over-the-bound', `total collateral ${tx.totalCollateral} over ${requiredCollateral(tx.fee, params)}`);
  }

  const unnamedInput = tx.inputs.find((r) => {
    const c = resolved[r] && credentialsOf(resolved[r].address).payment;
    return c && !request.funding.includes(r) && (c.kind === 'key' || payments.has(c.hash));
  });
  if (unnamedInput) fail('buyer-outflow-over-the-sale', 'unnamed-buyer-input', `input ${unnamedInput} is spent by a key the request does not name`);
  if (tx.withdrawals.some((w) => buyerCreds.has(w.credential.hash))) {
    fail('buyer-outflow-over-the-sale', 'buyer-withdrawal', "the body withdraws a buyer credential's rewards");
  }
  if (tx.fee > maxFee(params)) fail('buyer-outflow-over-the-sale', 'fee-over-the-max', `fee ${tx.fee} over a maximal transaction's ${maxFee(params)}`);
  if (premium > request.premium) {
    fail('buyer-outflow-over-the-sale', 'leg-premiums-over-the-request', `leg premiums ${premium} over the request's ${request.premium}`);
  }
  if (pOut && pOut.lovelace !== request.deposit) {
    fail('buyer-outflow-over-the-sale', 'p-leg-not-the-deposit', `the P-leg holds ${pOut.lovelace}, not the deposit ${request.deposit}`);
  }
  const foreignMint = Object.keys(tx.mint).filter((p) => p !== position);
  if (foreignMint.length) fail('buyer-outflow-over-the-sale', 'foreign-mint', `the body mints under ${foreignMint.join(', ')}`);

  let lovelaceFlow = 0n;
  const assetFlow: Record<string, bigint> = {};
  const flow = (o: { address: string; lovelace: bigint; assets: Assets }, sign: bigint) => {
    if (!buyerAddresses.has(o.address)) return;
    lovelaceFlow += sign * o.lovelace;
    for (const [p, names] of Object.entries(o.assets)) {
      for (const [n, q] of Object.entries(names)) assetFlow[p + n] = (assetFlow[p + n] ?? 0n) + sign * q;
    }
  };
  for (const r of tx.inputs) if (resolved[r]) flow(resolved[r], -1n);
  for (const o of tx.outputs) flow(o, 1n);
  for (const [unit, q] of Object.entries(assetFlow)) {
    if (q < 0n) fail('buyer-outflow-over-the-sale', 'net-asset-outflow', `the buyer's addresses lose ${-q} of ${unit}`);
  }
  const unresolvedFunding = request.funding.filter((r) => !resolved[r]);
  if (unresolvedFunding.length) {
    fail('buyer-outflow-over-the-sale', 'net-lovelace-outflow', `named funding ${unresolvedFunding.join(', ')} cannot be resolved`);
  }

  // Nothing foreign.
  const answered = (r: string) => {
    const o = resolved[r];
    const pay = credentialsOf(o.address).payment;
    return !pay || pay.kind === 'key' || pay.hash === inst.bookHash ||
      (pay.hash === position && quantity(o.assets, inst.beaconPolicy, inst.beaconName) === 1n);
  };
  if (tx.inputs.some((r) => resolved[r] && !answered(r))) {
    fail('sale-foreign-purpose', 'foreign-script-input', 'a script input that is neither the book nor a Head');
  }
  const unresolved = [...tx.inputs, ...tx.collateral, ...tx.referenceInputs].filter((r) => !resolved[r]);
  if (unresolved.length) fail('sale-foreign-purpose', 'input-unresolved', `the buyer's reads resolve no ${unresolved.join(', ')}`);
  const foreignSigners = tx.requiredSigners.filter((k) => !payments.has(k));
  if (foreignSigners.length) fail('sale-foreign-purpose', 'foreign-required-signer', `required signers ${foreignSigners.join(', ')} are not the buyer's keys`);
  if (tx.withdrawals.some((w) => !(w.credential.kind === 'script' && w.credential.hash === inst.observerHash) && !buyerCreds.has(w.credential.hash))) {
    fail('sale-foreign-purpose', 'foreign-withdrawal', 'a withdrawal at neither the observer nor a buyer credential');
  }
  if (tx.certificates) fail('sale-foreign-purpose', 'certificate', `the body carries ${tx.certificates} certificate(s)`);
  if (tx.otherBodyKeys.length) fail('sale-foreign-purpose', 'foreign-body-field', `the body carries keys ${tx.otherBodyKeys.join(', ')}`);
  if (tx.otherWitnessKeys.length) fail('sale-foreign-purpose', 'foreign-witness', `the witness set carries keys ${tx.otherWitnessKeys.join(', ')}`);

  // The window.
  if (pd) {
    if (tx.validFromSlot === null || tx.validToSlot === null) {
      fail('sale-window', 'validity-unbounded', "the body's validity range is not finite");
    } else {
      const lower = slotToPosixMs(tx.validFromSlot, inst.network);
      const upper = slotToPosixMs(tx.validToSlot, inst.network);
      if (upper - lower > G3_MAX_UNDERWRITE_SPAN_MS) fail('sale-window', 'span-over-the-max', `a span of ${upper - lower} ms`);
      if (pd.startMs < upper) fail('sale-window', 'start-before-the-upper-bound', 'the policy starts before the upper bound');
      const reading = tx.referenceInputs
        .map((r) => resolved[r])
        .filter((o) => o && credentialsOf(o.address).payment?.kind === 'key' && credentialsOf(o.address).payment?.hash === inst.publisherVkh &&
          o.assets[pd.feed] !== undefined && o.datum?.kind === 'inline')
        .map((o) => tryDecode(() => decodeFeedReading((o.datum as { cbor: string }).cbor)))
        .find((r) => r !== null);
      if (!reading) {
        fail('sale-window', 'reading-not-referenced', "no publisher reading of the policy's feed among the references");
      } else {
        if (reading.observedAt > upper) fail('sale-window', 'observed-after-the-upper-bound', 'the reading was observed after the upper bound');
        if (upper > reading.validUntil) fail('sale-window', 'valid-until-before-the-upper-bound', 'the reading lapses before the upper bound');
        if (reading.min12h > reading.spot) fail('sale-window', 'twelve-hour-low-above-spot', "the reading's twelve-hour low is above its spot");
        const age = G3_MAX_SPOT_AGE_MS[pd.class];
        if (age === undefined || pd.startMs > reading.observedAt + age) {
          fail('sale-window', 'spot-older-than-the-class-allows', 'the spot is older than the class allows at start');
        }
      }
    }
  }

  // The fee and the donation.
  const toTreasury = tx.outputs.filter((o) => o.address === inst.treasury);
  const feeOut = toTreasury.find((o) => digest && o.datum?.kind === 'inline' && o.datum.cbor === g3DigestDatum(digest)) ?? toTreasury[0];
  if (!feeOut) {
    fail('protocol-fee-short', 'fee-output-missing', 'no output pays the treasury');
  } else {
    if (feeOut.lovelace * BPS < premium * inst.feeBps) fail('protocol-fee-short', 'fee-under-the-rate', `fee output ${feeOut.lovelace} under the rate`);
    if (!digest || feeOut.datum?.kind !== 'inline' || feeOut.datum.cbor !== g3DigestDatum(digest)) {
      fail('protocol-fee-short', 'fee-output-without-the-digest', 'the fee output does not carry the position digest');
    }
  }
  const owed = g3Donation(premium, inst);
  const pairOnly = Object.keys(tx.mint).length === 1 && Object.keys(mintedHere).length === 2;
  const accrual = scriptAddress(inst.accrualHash, inst.network);
  const accrued = tx.outputs.some((o) => o.address === accrual && digest && o.datum?.kind === 'inline' &&
    o.datum.cbor === g3DigestDatum(digest) && o.lovelace >= owed);
  if (!(pairOnly && (tx.donation ?? 0n) >= owed) && !accrued) {
    fail('donation-short', 'treasury-donation', `neither a key-22 donation nor an accrual output carries ${owed}`);
  }

  // The quote.
  if (premium !== quote.premium) fail('sale-not-the-quote', 'premium', `the legs ask ${premium}, not the quoted ${quote.premium}`);
  const fee = g3ProtocolFee(premium, inst, params);
  const needs = { unit: premium + fee, lovelace: owed + request.deposit };
  if (needs.unit > quote.needs.unit || needs.lovelace > quote.needs.lovelace) {
    fail('sale-not-the-quote', 'charges', `the sale charges ${needs.unit} + ${needs.lovelace}, over the quoted ${quote.needs.unit} + ${quote.needs.lovelace}`);
  }
  const allowed = needs.unit + needs.lovelace + tx.fee;
  if (!unresolvedFunding.length && -lovelaceFlow > allowed) {
    fail('buyer-outflow-over-the-sale', 'net-lovelace-outflow', `the buyer's addresses lose ${-lovelaceFlow}, over the sale's ${allowed}`);
  }

  if (!unresolved.length && !tx.certificates && !tx.otherBodyKeys.length && !tx.otherWitnessKeys.length) {
    phaseOne(tx, resolved, params, fail);
  }
  return problems;
}

/** The ledger's phase-one rules a buyer can check offline: balance, fee, min-UTxO, size, units and collateral. */
function phaseOne(
  tx: DecodedTransaction,
  resolved: Record<string, ResolvedOutput>,
  params: ProtocolParams,
  fail: (code: string, conjunct: string, detail: string) => void,
): void {
  const draft = txViewOf(tx);
  const net: Record<string, bigint> = { lovelace: 0n };
  const add = (lovelace: bigint, assets: Assets, sign: bigint) => {
    net.lovelace += sign * lovelace;
    for (const [p, names] of Object.entries(assets)) for (const [n, q] of Object.entries(names)) net[p + n] = (net[p + n] ?? 0n) + sign * q;
  };
  for (const r of tx.inputs) add(resolved[r].lovelace, resolved[r].assets, 1n);
  for (const w of tx.withdrawals) add(w.amount, {}, 1n);
  add(0n, tx.mint, 1n);
  for (const o of tx.outputs) add(o.lovelace, o.assets, -1n);
  add(tx.fee + (tx.donation ?? 0n), {}, -1n);
  const off = Object.entries(net).filter(([, q]) => q !== 0n);
  if (off.length) fail('phase-one', 'value-not-conserved', `unbalanced by ${off.map(([u, q]) => `${q} ${u}`).join(', ')}`);

  const keys = new Set(tx.requiredSigners);
  for (const r of [...tx.inputs, ...tx.collateral]) {
    const pay = credentialsOf(resolved[r].address).payment;
    if (pay?.kind === 'key') keys.add(pay.hash);
  }
  const refBytes = [...new Set([...tx.inputs, ...tx.referenceInputs])].reduce((s, r) => s + (resolved[r].referenceScript?.size ?? 0), 0);
  const least = minFee(draft, params, { witnesses: keys.size, referenceScriptBytes: refBytes });
  if (tx.fee < least) fail('phase-one', 'fee-under-the-min', `fee ${tx.fee} under the ledger's ${least}`);
  tx.outputs.forEach((o, at) => {
    const floor = minUtxo(o, params);
    if (o.lovelace < floor) fail('phase-one', 'output-under-min-utxo', `output ${at} holds ${o.lovelace}, under ${floor}`);
  });
  const size = ledgerSize(draft, keys.size);
  if (size > params.maxTxSize) fail('phase-one', 'size-over-the-max', `${size} bytes, over ${params.maxTxSize}`);
  const mem = tx.redeemers.reduce((s, r) => s + r.mem, 0n);
  const steps = tx.redeemers.reduce((s, r) => s + r.steps, 0n);
  if (mem > params.maxTxMem || steps > params.maxTxSteps) fail('phase-one', 'units-over-the-max', `${mem} memory, ${steps} steps`);
  if (tx.redeemers.length) {
    const held = tx.collateral.reduce((s, r) => s + resolved[r].lovelace, 0n) - (tx.collateralReturn?.lovelace ?? 0n);
    if (held < requiredCollateral(tx.fee, params)) fail('phase-one', 'collateral-short', `collateral ${held} under ${requiredCollateral(tx.fee, params)}`);
    if (tx.totalCollateral !== null && held !== tx.totalCollateral) {
      fail('phase-one', 'total-collateral-not-held', `the collateral nets ${held}, not the stated ${tx.totalCollateral}`);
    }
  }
}

/** The ledger's phase-one rules over a transaction whose every spent and referenced output `resolved` holds. */
export function ledgerPhaseOne(
  tx: string | Uint8Array,
  resolved: Record<string, ResolvedOutput>,
  params: ProtocolParams,
): G3SaleProblem[] {
  const problems: G3SaleProblem[] = [];
  phaseOne(decodeTransaction(tx), resolved, params, (code, conjunct, detail) => problems.push({ code, conjunct, detail }));
  return problems;
}
