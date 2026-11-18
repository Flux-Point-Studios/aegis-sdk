// A Conway transaction as a buyer's code reads, re-writes and prices it.
//
// decodeTransaction reads every body field a sale or a borrow carries and keeps the body's
// own bytes, so the id is the hash of what was signed rather than of a re-encoding. A
// TxDraft is the plain data of a transaction with no key witnesses; encodeTransaction
// writes one in the form the reference builder writes (definite arrays and maps, body keys
// ascending, outputs as maps, assets in hex order, redeemers by purpose then index), and
// minFee and minUtxo price it the way Conway's ledger does.

import { cArray, cBytes, cInt, cMap, decodeCborItem, encodeCborItem, type CborItem } from './cbor_item';
import { blake2b, blake2b224 } from './blake2b';
import { bytesToHex, concat, hexToBytes } from './cbor';
import { InputError } from './errors';

export type Assets = Record<string, Record<string, bigint>>;

export type TxDatum = { kind: 'inline'; cbor: string } | { kind: 'hash'; hash: string };

export interface TxOutput {
  /** The address bytes, hex. */
  address: string;
  lovelace: bigint;
  assets: Assets;
  datum: TxDatum | null;
  /** The script reference's CBOR ([language, script bytes]), hex. */
  scriptRef: string | null;
}

export interface StakeCredential {
  kind: 'key' | 'script';
  hash: string;
}

export interface Withdrawal {
  credential: StakeCredential;
  networkId: number;
  amount: bigint;
}

export type RedeemerPurpose = 'spend' | 'mint' | 'cert' | 'withdraw' | 'vote' | 'propose';

export interface TxRedeemer {
  purpose: RedeemerPurpose;
  index: number;
  /** The redeemer's Plutus data as written, hex. */
  data: string;
  mem: bigint;
  steps: bigint;
}

/** A transaction without key witnesses or certificates: what a builder writes and a fee prices. */
export interface TxDraft {
  /** Spent outputs as "txid#index", in the order the body lists them. */
  inputs: string[];
  outputs: TxOutput[];
  fee: bigint;
  validFromSlot: bigint | null;
  validToSlot: bigint | null;
  withdrawals: Withdrawal[];
  mint: Assets;
  auxiliaryDataHash: string | null;
  scriptDataHash: string | null;
  collateral: string[];
  requiredSigners: string[];
  networkId: number | null;
  collateralReturn: TxOutput | null;
  totalCollateral: bigint | null;
  referenceInputs: string[];
  /** Body key 22: lovelace donated to the Cardano treasury. */
  donation: bigint | null;
  redeemers: TxRedeemer[];
  /** The auxiliary data as written, hex. */
  auxiliaryData: string | null;
}

export interface DecodedTransaction extends TxDraft {
  /** blake2b-256 of the body's own bytes. */
  id: string;
  /** How many certificates the body carries; a draft carries none. */
  certificates: number;
  /** Body keys no field above reads: votes, proposals, updates and any later addition. */
  otherBodyKeys: number[];
  /** The key hash of each vkey witness. */
  vkeyWitnesses: string[];
  /** Witness-set keys besides vkeys (0) and redeemers (5): scripts, datums, bootstrap witnesses. */
  otherWitnessKeys: number[];
  isValid: boolean;
}

/** The protocol parameters a fee and a min-UTxO read, prices as exact fractions. */
export interface ProtocolParams {
  minFeeA: bigint;
  minFeeB: bigint;
  priceMem: [bigint, bigint];
  priceSteps: [bigint, bigint];
  refScriptCostPerByte: [bigint, bigint];
  coinsPerUtxoByte: bigint;
  maxTxSize: number;
  maxValueSize: number;
  maxTxMem: bigint;
  maxTxSteps: bigint;
  collateralPercent: bigint;
  costModelsV3: bigint[];
}

const PURPOSES: readonly RedeemerPurpose[] = ['spend', 'mint', 'cert', 'withdraw', 'vote', 'propose'];
const READ_BODY_KEYS = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 11, 13, 14, 15, 16, 17, 18, 22]);
const UTXO_ENTRY_OVERHEAD = 160n;
const VKEY_WITNESS_BYTES = 101;
const VKEY_SET_BYTES = 5;
const REF_SCRIPT_STRIDE = 25_600n;

function refuse(message: string): never {
  throw new InputError('INVALID_INPUT', `transaction: ${message}`);
}

function bytesOf(raw: Uint8Array | string): Uint8Array {
  if (typeof raw !== 'string') return raw;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(raw)) refuse('not hex');
  return hexToBytes(raw);
}

// --- reading ------------------------------------------------------------------------

function asInt(it: CborItem, what: string): bigint {
  if (it.t !== 'int') refuse(`${what} is not an integer`);
  return it.v;
}

function asUint(it: CborItem, what: string): bigint {
  const v = asInt(it, what);
  if (v < 0n) refuse(`${what} is negative`);
  return v;
}

function asBytes(it: CborItem, what: string, size?: number): Uint8Array {
  if (it.t !== 'bytes') refuse(`${what} is not bytes`);
  if (size !== undefined && it.v.length !== size) refuse(`${what} is not ${size} bytes`);
  return it.v;
}

function asArray(it: CborItem, what: string): CborItem[] {
  if (it.t !== 'array') refuse(`${what} is not an array`);
  return it.items;
}

/** An array, or a Conway set: an array under tag 258. */
function asSet(it: CborItem, what: string): CborItem[] {
  return asArray(it.t === 'tag' && it.tag === 258n ? it.item : it, what);
}

function asMap(it: CborItem, what: string): Array<[CborItem, CborItem]> {
  if (it.t !== 'map') refuse(`${what} is not a map`);
  return it.entries;
}

function rawHex(it: CborItem): string {
  return bytesToHex(encodeCborItem(it));
}

function readInput(it: CborItem): string {
  const pair = asArray(it, 'an input');
  if (pair.length !== 2) refuse('an input is not a [tx id, index] pair');
  return `${bytesToHex(asBytes(pair[0], 'an input tx id', 32))}#${asUint(pair[1], 'an input index')}`;
}

function readMultiAsset(it: CborItem, what: string): Assets {
  const out: Assets = {};
  for (const [p, names] of asMap(it, what)) {
    const policy = bytesToHex(asBytes(p, `${what} policy`, 28));
    out[policy] = {};
    for (const [n, q] of asMap(names, `${what} names`)) {
      out[policy][bytesToHex(asBytes(n, `${what} asset name`))] = asInt(q, `${what} quantity`);
    }
  }
  return out;
}

function readValue(it: CborItem): { lovelace: bigint; assets: Assets } {
  if (it.t === 'int') return { lovelace: asUint(it, 'an output coin'), assets: {} };
  const pair = asArray(it, 'an output value');
  if (pair.length !== 2) refuse('an output value is not [coin, assets]');
  return { lovelace: asUint(pair[0], 'an output coin'), assets: readMultiAsset(pair[1], 'an output value') };
}

function tagged24(it: CborItem, what: string): string {
  if (it.t !== 'tag' || it.tag !== 24n) refuse(`${what} is not tag 24`);
  return bytesToHex(asBytes(it.item, what));
}

function readOutput(it: CborItem): TxOutput {
  if (it.t === 'array') {
    if (it.items.length < 2 || it.items.length > 3) refuse('a legacy output is not [address, value, datum hash?]');
    return {
      address: bytesToHex(asBytes(it.items[0], 'an output address')),
      ...readValue(it.items[1]),
      datum: it.items[2] ? { kind: 'hash', hash: bytesToHex(asBytes(it.items[2], 'a datum hash', 32)) } : null,
      scriptRef: null,
    };
  }
  const fields = new Map(asMap(it, 'an output').map(([k, v]) => [Number(asUint(k, 'an output key')), v]));
  const address = fields.get(0);
  const value = fields.get(1);
  if (!address || !value) refuse('an output lacks its address or value');
  let datum: TxDatum | null = null;
  const d = fields.get(2);
  if (d) {
    const [kind, payload] = asArray(d, 'an output datum');
    datum = asUint(kind, 'a datum kind') === 1n
      ? { kind: 'inline', cbor: tagged24(payload, 'an inline datum') }
      : { kind: 'hash', hash: bytesToHex(asBytes(payload, 'a datum hash', 32)) };
  }
  const ref = fields.get(3);
  return {
    address: bytesToHex(asBytes(address, 'an output address')),
    ...readValue(value),
    datum,
    scriptRef: ref ? tagged24(ref, 'a script reference') : null,
  };
}

function readWithdrawal([k, v]: [CborItem, CborItem]): Withdrawal {
  const account = asBytes(k, 'a reward address', 29);
  if (account[0] >> 5 !== 7) refuse('a withdrawal is not from a reward address');
  return {
    credential: { kind: account[0] & 0x10 ? 'script' : 'key', hash: bytesToHex(account.subarray(1)) },
    networkId: account[0] & 0x0f,
    amount: asUint(v, 'a withdrawal amount'),
  };
}

function readRedeemer(tag: CborItem, index: CborItem, data: CborItem, units: CborItem): TxRedeemer {
  const purpose = PURPOSES[Number(asUint(tag, 'a redeemer tag'))];
  if (!purpose) refuse('a redeemer tag is unknown');
  const [mem, steps] = asArray(units, 'redeemer units');
  return {
    purpose,
    index: Number(asUint(index, 'a redeemer index')),
    data: rawHex(data),
    mem: asUint(mem, 'redeemer memory'),
    steps: asUint(steps, 'redeemer steps'),
  };
}

function readRedeemers(it: CborItem): TxRedeemer[] {
  if (it.t === 'map') {
    return it.entries.map(([k, v]) => {
      const [tag, index] = asArray(k, 'a redeemer key');
      const [data, units] = asArray(v, 'a redeemer value');
      return readRedeemer(tag, index, data, units);
    });
  }
  return asArray(it, 'redeemers').map((r) => {
    const [tag, index, data, units] = asArray(r, 'a redeemer');
    return readRedeemer(tag, index, data, units);
  });
}

function vkeyItems(set: CborItem | undefined): CborItem[] {
  return set ? asSet(set, 'vkey witnesses') : [];
}

function splitTransaction(raw: Uint8Array | string): CborItem[] {
  const top = asArray(decodeCborItem(bytesOf(raw)), 'a transaction');
  if (top.length !== 4) refuse('a transaction is not [body, witnesses, validity, auxiliary data]');
  return top;
}

/** Decode a Conway transaction, hex or bytes, signed or not. */
export function decodeTransaction(raw: Uint8Array | string): DecodedTransaction {
  const [body, witnesses, validity, aux] = splitTransaction(raw);
  const fields = new Map(asMap(body, 'a body').map(([k, v]) => [Number(asUint(k, 'a body key')), v]));
  const at = (key: number) => fields.get(key);
  const inputs = at(0);
  const outputs = at(1);
  const fee = at(2);
  if (!inputs || !outputs || !fee) refuse('a body lacks its inputs, outputs or fee');
  const opt = <T>(key: number, read: (it: CborItem) => T): T | null => {
    const it = at(key);
    return it === undefined ? null : read(it);
  };
  const wits = new Map(asMap(witnesses, 'a witness set').map(([k, v]) => [Number(asUint(k, 'a witness key')), v]));
  if (validity.t !== 'simple' || (validity.v !== 20 && validity.v !== 21)) refuse('the validity flag is no boolean');
  return {
    id: bytesToHex(blake2b(encodeCborItem(body), 32)),
    inputs: asSet(inputs, 'inputs').map(readInput),
    outputs: asArray(outputs, 'outputs').map(readOutput),
    fee: asUint(fee, 'the fee'),
    validToSlot: opt(3, (it) => asUint(it, 'the validity upper bound')),
    certificates: opt(4, (it) => asSet(it, 'certificates').length) ?? 0,
    withdrawals: opt(5, (it) => asMap(it, 'withdrawals').map(readWithdrawal)) ?? [],
    auxiliaryDataHash: opt(7, (it) => bytesToHex(asBytes(it, 'the auxiliary data hash', 32))),
    validFromSlot: opt(8, (it) => asUint(it, 'the validity lower bound')),
    mint: opt(9, (it) => readMultiAsset(it, 'the mint')) ?? {},
    scriptDataHash: opt(11, (it) => bytesToHex(asBytes(it, 'the script data hash', 32))),
    collateral: opt(13, (it) => asSet(it, 'collateral').map(readInput)) ?? [],
    requiredSigners: opt(14, (it) => asSet(it, 'required signers').map((k) => bytesToHex(asBytes(k, 'a required signer', 28)))) ?? [],
    networkId: opt(15, (it) => Number(asUint(it, 'the network id'))),
    collateralReturn: opt(16, readOutput),
    totalCollateral: opt(17, (it) => asUint(it, 'the total collateral')),
    referenceInputs: opt(18, (it) => asSet(it, 'reference inputs').map(readInput)) ?? [],
    donation: opt(22, (it) => asUint(it, 'the donation')),
    otherBodyKeys: [...fields.keys()].filter((k) => !READ_BODY_KEYS.has(k)),
    vkeyWitnesses: vkeyItems(wits.get(0)).map((w) => {
      const [vkey] = asArray(w, 'a vkey witness');
      return bytesToHex(blake2b224(asBytes(vkey, 'a vkey', 32)));
    }),
    otherWitnessKeys: [...wits.keys()].filter((k) => k !== 0 && k !== 5),
    redeemers: wits.has(5) ? readRedeemers(wits.get(5) as CborItem) : [],
    isValid: validity.v === 21,
    auxiliaryData: aux.t === 'simple' && aux.v === 22 ? null : rawHex(aux),
  };
}

/** blake2b-256 of a transaction's body bytes, as they were written. */
export function transactionId(raw: Uint8Array | string): string {
  return bytesToHex(blake2b(encodeCborItem(splitTransaction(raw)[0]), 32));
}

/**
 * Add a CIP-30 signTx answer's vkey witnesses to a transaction. The body, the rest of the
 * witness set, the validity flag and the auxiliary data keep their bytes, so the id the
 * wallet signed is the id of the result.
 */
export function spliceVkeyWitnesses(tx: Uint8Array | string, witnessSet: Uint8Array | string): string {
  const [body, witnesses, validity, aux] = splitTransaction(tx);
  const added = asMap(decodeCborItem(bytesOf(witnessSet)), 'a witness set').find(([k]) => k.t === 'int' && k.v === 0n);
  const fresh = vkeyItems(added?.[1]);
  if (fresh.length === 0) refuse('the witness set carries no vkey witness');
  const entries = asMap(witnesses, 'a witness set');
  const present = entries.find(([k]) => k.t === 'int' && k.v === 0n);
  const vkeys = [...vkeyItems(present?.[1])];
  const seen = new Set(vkeys.map(rawHex));
  for (const w of fresh) if (!seen.has(rawHex(w))) vkeys.push(w);
  const merged = cMap([[cInt(0), cArray(vkeys)], ...entries.filter(([k]) => !(k.t === 'int' && k.v === 0n))]);
  return bytesToHex(concat([new Uint8Array([0x84]), ...[body, merged, validity, aux].map(encodeCborItem)]));
}

/** A decoded transaction as a draft: its fields without its id, key witnesses or bytes. */
export function txViewOf(tx: DecodedTransaction): TxDraft {
  if (tx.certificates > 0) refuse('a draft carries no certificates');
  if (tx.otherBodyKeys.length > 0) refuse(`a draft carries no body key ${tx.otherBodyKeys.join(', ')}`);
  if (tx.otherWitnessKeys.length > 0) refuse(`a draft carries no witness key ${tx.otherWitnessKeys.join(', ')}`);
  return {
    inputs: [...tx.inputs],
    outputs: tx.outputs.map(copyOutput),
    fee: tx.fee,
    validFromSlot: tx.validFromSlot,
    validToSlot: tx.validToSlot,
    withdrawals: tx.withdrawals.map((w) => ({ ...w, credential: { ...w.credential } })),
    mint: copyAssets(tx.mint),
    auxiliaryDataHash: tx.auxiliaryDataHash,
    scriptDataHash: tx.scriptDataHash,
    collateral: [...tx.collateral],
    requiredSigners: [...tx.requiredSigners],
    networkId: tx.networkId,
    collateralReturn: tx.collateralReturn && copyOutput(tx.collateralReturn),
    totalCollateral: tx.totalCollateral,
    referenceInputs: [...tx.referenceInputs],
    donation: tx.donation,
    redeemers: tx.redeemers.map((r) => ({ ...r })),
    auxiliaryData: tx.auxiliaryData,
  };
}

function copyAssets(a: Assets): Assets {
  return Object.fromEntries(Object.entries(a).map(([p, names]) => [p, { ...names }]));
}

function copyOutput(o: TxOutput): TxOutput {
  return { ...o, assets: copyAssets(o.assets), datum: o.datum && { ...o.datum } };
}

// --- writing ------------------------------------------------------------------------

function hexItem(hex: string, what: string): CborItem {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) refuse(`${what} is not hex`);
  return cBytes(hexToBytes(hex));
}

function inputItem(ref: string): CborItem {
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(ref);
  if (!m) refuse(`input ${ref} is not txid#index`);
  return cArray([hexItem(m[1], 'an input tx id'), cInt(BigInt(m[2]))]);
}

function multiAssetItem(assets: Assets): CborItem {
  return cMap(
    Object.keys(assets)
      .sort()
      .map((p) => [
        hexItem(p, 'a policy id'),
        cMap(Object.keys(assets[p]).sort().map((n) => [hexItem(n, 'an asset name'), cInt(assets[p][n])])),
      ]),
  );
}

function nonZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [p, names] of Object.entries(assets)) {
    const kept = Object.entries(names).filter(([, q]) => q !== 0n);
    if (kept.length > 0) out[p] = Object.fromEntries(kept);
  }
  return out;
}

function tag24(hex: string, what: string): CborItem {
  return { t: 'tag', tag: 24n, item: hexItem(hex, what) };
}

function outputItem(o: TxOutput): CborItem {
  const assets = nonZero(o.assets);
  const entries: Array<[CborItem, CborItem]> = [
    [cInt(0), hexItem(o.address, 'an output address')],
    [cInt(1), Object.keys(assets).length ? cArray([cInt(o.lovelace), multiAssetItem(assets)]) : cInt(o.lovelace)],
  ];
  if (o.datum?.kind === 'inline') entries.push([cInt(2), cArray([cInt(1), tag24(o.datum.cbor, 'an inline datum')])]);
  if (o.datum?.kind === 'hash') entries.push([cInt(2), cArray([cInt(0), hexItem(o.datum.hash, 'a datum hash')])]);
  if (o.scriptRef) entries.push([cInt(3), tag24(o.scriptRef, 'a script reference')]);
  return cMap(entries);
}

function rewardAccountItem(w: Withdrawal): CborItem {
  const header = 0xe0 | (w.credential.kind === 'script' ? 0x10 : 0) | w.networkId;
  return cBytes(concat([new Uint8Array([header]), hexToBytes(w.credential.hash)]));
}

/** The redeemers map, ordered by purpose then index. */
function redeemersItem(redeemers: TxRedeemer[]): CborItem {
  const sorted = [...redeemers].sort(
    (a, b) => PURPOSES.indexOf(a.purpose) - PURPOSES.indexOf(b.purpose) || a.index - b.index,
  );
  return cMap(
    sorted.map((r) => [
      cArray([cInt(PURPOSES.indexOf(r.purpose)), cInt(r.index)]),
      cArray([decodeCborItem(hexToBytes(r.data)), cArray([cInt(r.mem), cInt(r.steps)])]),
    ]),
  );
}

function bodyItem(d: TxDraft, scriptDataHash: string | null): CborItem {
  const entries: Array<[CborItem, CborItem]> = [
    [cInt(0), cArray(d.inputs.map(inputItem))],
    [cInt(1), cArray(d.outputs.map(outputItem))],
    [cInt(2), cInt(d.fee)],
  ];
  const put = (key: number, it: CborItem) => entries.push([cInt(key), it]);
  if (d.validToSlot !== null) put(3, cInt(d.validToSlot));
  if (d.withdrawals.length) put(5, cMap(d.withdrawals.map((w) => [rewardAccountItem(w), cInt(w.amount)])));
  if (d.auxiliaryDataHash !== null) put(7, hexItem(d.auxiliaryDataHash, 'the auxiliary data hash'));
  if (d.validFromSlot !== null) put(8, cInt(d.validFromSlot));
  const mint = nonZero(d.mint);
  if (Object.keys(mint).length) put(9, multiAssetItem(mint));
  if (scriptDataHash !== null) put(11, hexItem(scriptDataHash, 'the script data hash'));
  if (d.collateral.length) put(13, cArray(d.collateral.map(inputItem)));
  if (d.requiredSigners.length) put(14, cArray(d.requiredSigners.map((k) => hexItem(k, 'a required signer'))));
  if (d.networkId !== null) put(15, cInt(d.networkId));
  if (d.collateralReturn) put(16, outputItem(d.collateralReturn));
  if (d.totalCollateral !== null) put(17, cInt(d.totalCollateral));
  if (d.referenceInputs.length) put(18, cArray(d.referenceInputs.map(inputItem)));
  if (d.donation !== null) put(22, cInt(d.donation));
  return cMap(entries);
}

function witnessSetItem(d: TxDraft): CborItem {
  return cMap(d.redeemers.length ? [[cInt(5), redeemersItem(d.redeemers)]] : []);
}

function auxItem(d: TxDraft): CborItem {
  return d.auxiliaryData === null ? { t: 'simple', v: 22 } : decodeCborItem(hexToBytes(d.auxiliaryData));
}

/** The draft as an unsigned transaction. */
export function encodeTransaction(d: TxDraft): Uint8Array {
  return encodeCborItem(cArray([bodyItem(d, d.scriptDataHash), witnessSetItem(d), { t: 'simple', v: 21 }, auxItem(d)]));
}

/** The id the draft will have: blake2b-256 of its body as encodeTransaction writes it. */
export function draftId(d: TxDraft): string {
  return bytesToHex(blake2b(encodeCborItem(bodyItem(d, d.scriptDataHash)), 32));
}

/** Conway's script integrity hash for redeemers with no witness datums under PlutusV3. */
export function scriptDataHash(redeemers: TxRedeemer[], costModelsV3: bigint[]): string {
  const views = cMap([[cInt(2), cArray(costModelsV3.map(cInt))]]);
  return bytesToHex(blake2b(concat([encodeCborItem(redeemersItem(redeemers)), encodeCborItem(views)]), 32));
}

// --- pricing ------------------------------------------------------------------------

function cborUintSize(n: number): number {
  return n < 24 ? 1 : n < 256 ? 2 : n < 65536 ? 3 : 5;
}

/** The bytes `witnesses` vkey witnesses add to a witness set: key 0, a tag-258 set head and each pair. */
function vkeyWitnessSize(witnesses: number): number {
  return witnesses ? witnesses * VKEY_WITNESS_BYTES + VKEY_SET_BYTES - 1 + cborUintSize(witnesses) : 0;
}

/** The size the ledger fees once `witnesses` keys sign: [body, witness set, aux] with no validity flag. */
export function ledgerSize(d: TxDraft, witnesses: number): number {
  const integrity = d.redeemers.length ? '00'.repeat(32) : null;
  const unsigned = encodeCborItem(cArray([bodyItem(d, integrity), witnessSetItem(d), auxItem(d)]));
  return unsigned.length + vkeyWitnessSize(witnesses);
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

/** Conway's tiered reference-script fee: each 25,600 B stride priced 6/5 of the last, the total floored. */
export function refScriptFee(bytes: number, perByte: [bigint, bigint]): bigint {
  let [num, den] = perByte;
  let size = BigInt(bytes);
  let accNum = 0n;
  let accDen = 1n;
  while (size >= REF_SCRIPT_STRIDE) {
    accNum = accNum * den + REF_SCRIPT_STRIDE * num * accDen;
    accDen *= den;
    num *= 6n;
    den *= 5n;
    size -= REF_SCRIPT_STRIDE;
  }
  return (accNum * den + size * num * accDen) / (accDen * den);
}

/** The lovelace a draft's redeemers cost at their declared units, rounded up once. */
export function executionFee(redeemers: TxRedeemer[], params: ProtocolParams): bigint {
  const mem = redeemers.reduce((s, r) => s + r.mem, 0n);
  const steps = redeemers.reduce((s, r) => s + r.steps, 0n);
  const [mn, md] = params.priceMem;
  const [sn, sd] = params.priceSteps;
  return ceilDiv(mem * mn * sd + steps * sn * md, md * sd);
}

/** Conway's minimum fee for the draft once `witnesses` keys sign it, with `referenceScriptBytes` read. */
export function minFee(
  d: TxDraft,
  params: ProtocolParams,
  opts: { witnesses: number; referenceScriptBytes: number },
): bigint {
  return (
    params.minFeeA * BigInt(ledgerSize(d, opts.witnesses)) +
    params.minFeeB +
    executionFee(d.redeemers, params) +
    refScriptFee(opts.referenceScriptBytes, params.refScriptCostPerByte)
  );
}

/** The ledger's minimum lovelace for an output: (160 + its size) per byte, solved for its own coin field. */
export function minUtxo(o: TxOutput, params: ProtocolParams): bigint {
  let need = o.lovelace;
  for (let i = 0; i < 4; i++) {
    need = (UTXO_ENTRY_OVERHEAD + BigInt(encodeCborItem(outputItem({ ...o, lovelace: need })).length)) * params.coinsPerUtxoByte;
  }
  return need;
}

/** Collateral the ledger asks of a fee: collateralPercent of it, rounded up. */
export function requiredCollateral(fee: bigint, params: ProtocolParams): bigint {
  return ceilDiv(fee * params.collateralPercent, 100n);
}

function rational(x: unknown, what: string): [bigint, bigint] {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) refuse(`${what} is not a non-negative number`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x));
  if (!m) refuse(`${what} is not a decimal`);
  const digits = BigInt(m[1] + (m[2] ?? ''));
  const exp = Number(m[3] ?? 0) - (m[2] ?? '').length;
  return exp >= 0 ? [digits * 10n ** BigInt(exp), 1n] : [digits, 10n ** BigInt(-exp)];
}

function whole(x: unknown, what: string): bigint {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) refuse(`${what} is not a whole number`);
  return BigInt(x);
}

/**
 * Protocol parameters from `cardano-cli query protocol-parameters` JSON, which Koios'
 * cli_protocol_params also answers with. Decimal prices become the exact fractions they spell.
 */
export function protocolParamsFromCli(json: Record<string, unknown>): ProtocolParams {
  const prices = json.executionUnitPrices as Record<string, unknown> | undefined;
  const maxUnits = json.maxTxExecutionUnits as Record<string, unknown> | undefined;
  const costModels = json.costModels as Record<string, unknown> | undefined;
  const v3 = costModels?.PlutusV3;
  if (!prices || !maxUnits || !Array.isArray(v3)) refuse('the parameters lack prices, unit limits or PlutusV3 cost models');
  return {
    minFeeA: whole(json.txFeePerByte, 'txFeePerByte'),
    minFeeB: whole(json.txFeeFixed, 'txFeeFixed'),
    priceMem: rational(prices.priceMemory, 'priceMemory'),
    priceSteps: rational(prices.priceSteps, 'priceSteps'),
    refScriptCostPerByte: rational(json.minFeeRefScriptCostPerByte, 'minFeeRefScriptCostPerByte'),
    coinsPerUtxoByte: whole(json.utxoCostPerByte, 'utxoCostPerByte'),
    maxTxSize: Number(whole(json.maxTxSize, 'maxTxSize')),
    maxValueSize: Number(whole(json.maxValueSize, 'maxValueSize')),
    maxTxMem: whole(maxUnits.memory, 'maxTxExecutionUnits.memory'),
    maxTxSteps: whole(maxUnits.steps, 'maxTxExecutionUnits.steps'),
    collateralPercent: whole(json.collateralPercentage, 'collateralPercentage'),
    costModelsV3: v3.map((c) => {
      if (typeof c !== 'number' || !Number.isSafeInteger(c)) refuse('a PlutusV3 cost is not an integer');
      return BigInt(c);
    }),
  };
}
