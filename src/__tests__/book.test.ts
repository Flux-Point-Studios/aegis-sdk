// The gen-3 Book buyer flow against the first gen-3 sale on preview (cf447ae7): the request
// hashes and the reservation payload are the bytes the API verified the buyer's signData
// over, the API calls carry and read what the routes do, and verifyG3Sale passes the sale
// that landed while refusing each one-field departure from it under its own name.

import { describe, it, expect } from 'vitest';
import {
  BookRefusal,
  G3_PREVIEW_ADA,
  canonicalJson,
  decodeFeedReading,
  decodeG3LegDatum,
  decodeG3PolicyDatum,
  g3DepthBps,
  g3Digest,
  g3Donation,
  g3LegPremium,
  g3PLegDeposit,
  g3ProtocolFee,
  g3RequestHash,
  g3ReservationPayload,
  g3SheetCell,
  prepareG3Cover,
  quoteG3Cover,
  readResolvedOutputs,
  resolvedOutputsFromKoios,
  submitG3Sale,
  verifyG3Sale,
} from '../book';
import type { G3CoverRequest, G3Instance, G3Quote, ResolvedOutput } from '../book';
import { decodeCborItem, encodeCborItem } from '../cbor_item';
import type { CborItem } from '../cbor_item';
import { bytesToHex, hexToBytes } from '../cbor';
import type { MinimalFetch } from '../fetch_quote';
import type { KoiosUtxo } from '../koios';
import { decodePlutusData, encodePlutusData } from '../plutus_data';
import type { PlutusConstr, PlutusData } from '../plutus_data';
import { decodeTransaction, encodeTransaction, protocolParamsFromCli, txViewOf } from '../tx';
import type { ProtocolParams, TxDraft } from '../tx';
import sale from './fixtures/g3_preview_sale.json';
import cli from './fixtures/preview_protocol_params.json';

const PARAMS = protocolParamsFromCli(cli.response);
const DIGEST = '9f2f99d6d154d220550ada857535a79b111a1e85898bdfebf862ce3a';
const HEAD = '9b9df872bf82aeaf2f03a9c297fa44450cff0499a48f3b8345aaae1c97dd08ae#0';
const FUNDING = '93492f0ed239f3d3da55e095defdd347d5ee2d69d53edadeff1aeb7502b9b6eb#4';
const READING = '09e25e1b38bc8ffb';
const TABLE = '6a659cf8f39f4ac5';
const BASE = 'https://api.example';

const request: G3CoverRequest = {
  ...sale.request,
  strike: BigInt(sale.request.strike),
  coverage: BigInt(sale.request.coverage),
  term_ms: BigInt(sale.request.term_ms),
  premium: BigInt(sale.request.premium),
  deposit: BigInt(sale.request.deposit),
  transport_cap: null,
  payout_address: null,
  saturn_order: null,
  pin: null,
};
const rows = sale.utxoInfo as KoiosUtxo[];
const resolved = resolvedOutputsFromKoios(rows);

interface Call {
  url: string;
  body: string;
}

function fakeApi(answer: { status?: number; body: unknown }): { fetchImpl: MinimalFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: MinimalFetch = async (url, init) => {
    calls.push({ url, body: init?.body ?? '' });
    const status = answer.status ?? 200;
    return { ok: status === 200, status, json: async () => answer.body };
  };
  return { fetchImpl, calls };
}

async function theQuote(): Promise<G3Quote> {
  return quoteG3Cover({ baseUrl: BASE, fetchImpl: fakeApi({ body: sale.quote }).fetchImpl }, G3_PREVIEW_ADA, request);
}

describe('the request', () => {
  it('hashes to the request hash the reservation of the landed sale named', () => {
    expect(g3RequestHash(request)).toBe(sale.requestHash);
  });

  it('writes the reservation payload the insured signed', () => {
    expect(g3ReservationPayload(request)).toBe(sale.payload);
  });

  it("writes JSON as Python's sort_keys compact dumps does", () => {
    expect(canonicalJson({ b: 'é ', a: [1n, null, true], c: { z: 0, y: '"' } })).toBe(
      '{"a":[1,null,true],"b":"\\u00e9\\u2028","c":{"y":"\\"","z":0}}',
    );
    expect(() => canonicalJson(1.5)).toThrow(/whole numbers/);
  });

  it("sizes the P-leg deposit the sale's P-leg holds", () => {
    expect(g3PLegDeposit(request, G3_PREVIEW_ADA, PARAMS)).toBe(2111900n);
  });

  it('prices the fee output and the donation the sale paid', () => {
    expect(g3ProtocolFee(20_000_000n, G3_PREVIEW_ADA, PARAMS)).toBe(1137840n);
    expect(g3ProtocolFee(100_000_000n, G3_PREVIEW_ADA, PARAMS)).toBe(2_000_000n);
    expect(g3Donation(20_000_000n, G3_PREVIEW_ADA)).toBe(100000n);
  });

  it("names the position by its Head's out-ref", () => {
    expect(g3Digest(HEAD)).toBe(DIGEST);
    expect(() => g3Digest('9b9d#0')).toThrow(/txid#index/);
  });
});

describe('pricing', () => {
  const sheetRow = rows.find((r) => r.tx_hash.startsWith('bc72910169088cc8')) as KoiosUtxo;
  const sheet = (sheetRow.inline_datum as { bytes: string }).bytes;
  const reading = { spot: 150066n, observedAt: 0n, validUntil: 0n, min12h: 149403n, lowAt: 0n };

  it("reads the sale's depth from the lower of spot and the twelve-hour low", () => {
    expect(g3DepthBps(reading, 104000n)).toBe(3038n);
    expect(g3DepthBps({ ...reading, min12h: 160000n }, 104000n)).toBe(3069n);
  });

  it('finds the cell the sale was priced at', () => {
    expect(g3SheetCell(sheet, { class: 0, depthBps: 3038n, termMs: 604_800_000n })).toEqual({ cell: 6, rateBps: 275n });
    expect(() => g3SheetCell(sheet, { class: 1, depthBps: 3038n, termMs: 604_800_000n })).toThrow(/no cell/);
    expect(() => g3SheetCell('420102', { class: 0, depthBps: 3038n, termMs: 604_800_000n })).toThrow(/11-byte cells/);
  });

  it("prices a leg at the highest of the validator's floors", () => {
    const leg = { coverage: 50_000_000n, totalCoverage: 50_000_000n, rateBps: 275n, loadBps: 0n };
    expect(g3LegPremium(leg, G3_PREVIEW_ADA)).toBe(20_000_000n);
    expect(g3LegPremium({ ...leg, coverage: 400_000_000n, totalCoverage: 400_000_000n, rateBps: 900n }, G3_PREVIEW_ADA)).toBe(36_000_000n);
    expect(g3LegPremium({ ...leg, coverage: 300_000_000n, totalCoverage: 400_000_000n, rateBps: 100n, loadBps: 100n }, G3_PREVIEW_ADA)).toBe(15_000_000n);
    expect(g3LegPremium({ ...leg, coverage: 2_000_000n, totalCoverage: 1_000_000_000n, rateBps: 1n }, G3_PREVIEW_ADA)).toBe(1_000_000n);
  });
});

describe('datums', () => {
  const tx = decodeTransaction(sale.prepared);

  it("reads the P-leg's policy", () => {
    const pd = decodeG3PolicyDatum((tx.outputs[1].datum as { cbor: string }).cbor);
    expect(pd).toMatchObject({
      digest: DIGEST,
      insured: request.insured,
      strike: 104000n,
      coverage: 50_000_000n,
      premium: 20_000_000n,
      startMs: 1795039743000n,
      expiryMs: 1795039743000n + 604_800_000n,
      feed: request.feed,
      class: 0,
      provider: 2,
      partnerAddress: null,
      payoutAddress: null,
      settlementPins: null,
      extension: null,
      tail: 0,
    });
  });

  it("reads the leg's owner, terms and source", () => {
    expect(decodeG3LegDatum((tx.outputs[2].datum as { cbor: string }).cbor)).toEqual({
      owner: { kind: 'key', hash: '473dbb25d868c8ea6e60d5bb9660270621fdb9fde97e3cc68e60d0e0' },
      coverage: 50_000_000n,
      premium: 20_000_000n,
      source: 'a3e5dadfd53efa164e44ff8584e8f0c9fc769b651db5461f8a2f3ab29d763fb8#0',
      digest: DIGEST,
    });
  });

  it('reads the publisher reading the sale referenced', () => {
    const row = rows.find((r) => r.tx_hash.startsWith(READING)) as KoiosUtxo;
    expect(decodeFeedReading((row.inline_datum as { bytes: string }).bytes)).toEqual({
      spot: 150066n,
      observedAt: 1795039343725n,
      validUntil: 1795043543725n,
      min12h: 149403n,
      lowAt: 1794930710400n,
    });
    expect(() => decodeFeedReading(bytesToHex(encodePlutusData({ constructor: 0, fields: [{ constructor: 2, fields: [{ map: [[0n, 1n]] }] }] })))).toThrow(
      /keys 0, 1 and 2/,
    );
  });
});

describe('the API', () => {
  it('quotes by POSTing the canonical request to the instance', async () => {
    const api = fakeApi({ body: sale.quote });
    const quote = await quoteG3Cover({ baseUrl: BASE + '/', fetchImpl: api.fetchImpl }, G3_PREVIEW_ADA, request);
    expect(api.calls).toEqual([{ url: `${BASE}/api/book/g3/quote?network=preview&unit=lovelace`, body: canonicalJson(request) }]);
    expect(quote).toMatchObject({ premium: 20_000_000n, needs: { unit: 21137840n, lovelace: 2211900n }, legs: 1, fx: null });
  });

  it('refuses cover the Book cannot sell whole, and keeps the route code of a refusal', async () => {
    const short = fakeApi({ body: { ...sale.quote, available: false, coverage: 0 } });
    await expect(quoteG3Cover({ baseUrl: BASE, fetchImpl: short.fetchImpl }, G3_PREVIEW_ADA, request)).rejects.toMatchObject({
      refusal: 'cover-unavailable',
    });
    const held = fakeApi({ status: 409, body: { detail: { code: 'funding-reserved', detail: 'held' } } });
    const refusal = await prepareG3Cover({ baseUrl: BASE, fetchImpl: held.fetchImpl }, G3_PREVIEW_ADA, request, {}).catch((e) => e);
    expect(refusal).toBeInstanceOf(BookRefusal);
    expect(refusal).toMatchObject({ refusal: 'funding-reserved', code: 'BOOK_REFUSED' });
  });

  it("prepares with the insured's signData answer", async () => {
    const api = fakeApi({ body: { unit: 'lovelace', reservation: 'r1', body: {}, cbor: sale.prepared } });
    const signatures = { [request.insured]: { signature: 'aa', key: 'bb' } };
    const prepared = await prepareG3Cover({ baseUrl: BASE, fetchImpl: api.fetchImpl }, G3_PREVIEW_ADA, request, signatures);
    expect(prepared).toEqual({ reservation: 'r1', cbor: sale.prepared });
    expect(api.calls[0].body).toBe(canonicalJson({ request, signatures }));
  });

  it('submits the signed sale and checks the API names its id', async () => {
    const api = fakeApi({ body: { tx: sale.tx } });
    const prepared = { reservation: 'r1', cbor: sale.prepared };
    await expect(submitG3Sale({ baseUrl: BASE, fetchImpl: api.fetchImpl }, G3_PREVIEW_ADA, prepared, sale.witnessSet)).resolves.toBe(sale.tx);
    expect(JSON.parse(api.calls[0].body)).toEqual({ reservation: 'r1', cbor: sale.signed });
    const other = fakeApi({ body: { tx: '00'.repeat(32) } });
    await expect(submitG3Sale({ baseUrl: BASE, fetchImpl: other.fetchImpl }, G3_PREVIEW_ADA, prepared, sale.witnessSet)).rejects.toMatchObject({
      refusal: 'submit-answered-another-tx',
    });
  });

  it('reads every output a sale names from Koios, refusing one it does not hold', async () => {
    const koios = fakeApi({ body: rows });
    const refs = outputsOf(sale.prepared);
    const got = await readResolvedOutputs(refs, { network: 'preview', fetchImpl: koios.fetchImpl });
    expect(Object.keys(got).sort()).toEqual([...refs].sort());
    expect(JSON.parse(koios.calls[0].body)).toEqual({ _utxo_refs: refs, _extended: true });
    const partial = fakeApi({ body: rows.slice(1) });
    await expect(readResolvedOutputs(refs, { network: 'preview', fetchImpl: partial.fetchImpl })).rejects.toThrow(/holds no/);
  });
});

function outputsOf(hex: string): string[] {
  const tx = decodeTransaction(hex);
  return [...new Set([...tx.inputs, ...tx.collateral, ...tx.referenceInputs])];
}

// --- the judgement ---------------------------------------------------------------------

function draft(): TxDraft {
  return txViewOf(decodeTransaction(sale.prepared));
}

function written(d: TxDraft): string {
  return bytesToHex(encodeTransaction(d));
}

function editPolicy(d: TxDraft, field: number, value: PlutusData): void {
  const o = d.outputs[1];
  const pd = decodePlutusData((o.datum as { cbor: string }).cbor) as PlutusConstr;
  pd.fields[field] = value;
  o.datum = { kind: 'inline', cbor: bytesToHex(encodePlutusData(pd)) };
}

function withBodyKey(hex: string, key: number, value: CborItem): string {
  const top = decodeCborItem(hexToBytes(hex));
  if (top.t !== 'array' || top.items[0].t !== 'map') throw new Error('the fixture is no transaction');
  const body: CborItem = { t: 'map', entries: [...top.items[0].entries, [{ t: 'int', v: BigInt(key) }, value]] };
  return bytesToHex(encodeCborItem({ t: 'array', items: [body, ...top.items.slice(1)] }));
}

function withWitnessKey(hex: string, key: number, value: CborItem): string {
  const top = decodeCborItem(hexToBytes(hex));
  if (top.t !== 'array' || top.items[1].t !== 'map') throw new Error('the fixture is no transaction');
  const set: CborItem = { t: 'map', entries: [...top.items[1].entries, [{ t: 'int', v: BigInt(key) }, value]] };
  return bytesToHex(encodeCborItem({ t: 'array', items: [top.items[0], set, ...top.items.slice(2)] }));
}

function resolvedWith(ref: string, edit: (o: ResolvedOutput) => void): Record<string, ResolvedOutput> {
  const key = Object.keys(resolved).find((r) => r.startsWith(ref)) as string;
  const o: ResolvedOutput = { ...resolved[key], assets: { ...resolved[key].assets } };
  edit(o);
  return { ...resolved, [key]: o };
}

function readingWith(key: bigint, value: bigint): Record<string, ResolvedOutput> {
  return resolvedWith(READING, (o) => {
    const outer = decodePlutusData((o.datum as { cbor: string }).cbor) as PlutusConstr;
    const prices = outer.fields[0] as PlutusConstr;
    const m = prices.fields[0] as { map: Array<[PlutusData, PlutusData]> };
    m.map = m.map.map(([k, v]) => [k, k === key ? value : v]);
    o.datum = { kind: 'inline', cbor: bytesToHex(encodePlutusData(outer)) };
  });
}

function without(refPrefix: string): Record<string, ResolvedOutput> {
  return Object.fromEntries(Object.entries(resolved).filter(([r]) => !r.startsWith(refPrefix)));
}

interface JudgeOptions {
  quote?: G3Quote;
  resolved?: Record<string, ResolvedOutput>;
  instance?: G3Instance;
  params?: ProtocolParams;
}

async function judged(tx: string, opts: JudgeOptions = {}) {
  const quote = opts.quote ?? (await theQuote());
  const instance = opts.instance ?? G3_PREVIEW_ADA;
  return verifyG3Sale({ tx, request, quote, instance, resolved: opts.resolved ?? resolved, params: opts.params ?? PARAMS }).map(
    (p) => `${p.code}/${p.conjunct}`,
  );
}

const BUYER_STAKE = resolved[FUNDING].address.slice(58);

describe('verifyG3Sale', () => {
  it('passes the sale that landed', async () => {
    expect(await judged(sale.prepared)).toEqual([]);
  });

  it('refuses bytes the wallet has already witnessed', async () => {
    expect(await judged(sale.signed)).toContain('sale-already-witnessed/vkey-witness-present');
  });

  it('refuses an instance it does not judge', () => {
    expect(() =>
      verifyG3Sale({ tx: sale.prepared, request, quote: {} as G3Quote, instance: { ...G3_PREVIEW_ADA, unit: 'ab' }, resolved, params: PARAMS }),
    ).toThrow(/ADA instance/);
  });

  const b = (h: string) => hexToBytes(h);
  const mutants: Array<[string, (d: TxDraft) => void, string]> = [
    ['an insured other than the buyer', (d) => editPolicy(d, 1, b('11'.repeat(28))), 'insured-not-the-buyer/insured-key'],
    ['another strike', (d) => editPolicy(d, 2, 104001n), 'insured-not-the-buyer/strike'],
    ['less coverage', (d) => editPolicy(d, 3, 49_000_000n), 'insured-not-the-buyer/coverage'],
    ['a longer term', (d) => editPolicy(d, 6, 1795039743000n + 604_800_001n), 'insured-not-the-buyer/term'],
    ['another feed', (d) => editPolicy(d, 7, b('22'.repeat(28))), 'insured-not-the-buyer/feed'],
    ['another class', (d) => editPolicy(d, 13, { constructor: 1, fields: [] }), 'insured-not-the-buyer/class'],
    ['a payout address', (d) => editPolicy(d, 14, { constructor: 0, fields: [{ constructor: 0, fields: [] }] }), 'insured-not-the-buyer/payout-address'],
    ['another policy id', (d) => editPolicy(d, 0, b('33'.repeat(28))), 'p-leg-off-the-core-pins/policy-id-not-the-digest'],
    ['another provider', (d) => editPolicy(d, 10, { constructor: 0, fields: [] }), 'p-leg-off-the-core-pins/provider-not-aegis-self'],
    ['a partner share', (d) => editPolicy(d, 12, 100n), 'p-leg-off-the-core-pins/partner'],
    ['a receipt commitment', (d) => editPolicy(d, 15, { constructor: 0, fields: [b('44')] }), 'p-leg-off-the-core-pins/receipt-commitment'],
    ['settlement pins', (d) => editPolicy(d, 17, { constructor: 0, fields: [0n] }), 'p-leg-off-the-core-pins/settlement-pins'],
    ['an extension', (d) => editPolicy(d, 18, { constructor: 0, fields: [0n] }), 'p-leg-off-the-core-pins/extension'],
    ['another pool', (d) => editPolicy(d, 9, b('55'.repeat(28))), 'p-leg-off-the-core-pins/pool-not-the-instance'],
    ['a start inside the validity', (d) => {
      editPolicy(d, 5, 1795039742000n);
      editPolicy(d, 6, 1795039742000n + 604_800_000n);
    }, 'sale-window/start-before-the-upper-bound'],
    ['a P-leg over the deposit', (d) => {
      d.outputs[1].lovelace += 1n;
      d.outputs[5].lovelace -= 1n;
    }, 'buyer-outflow-over-the-sale/p-leg-not-the-deposit'],
    ['a staked P-leg', (d) => {
      d.outputs[1].address = '10' + G3_PREVIEW_ADA.positionHash + '66'.repeat(28);
    }, 'p-leg-not-at-the-position/p-leg-off-the-position-address'],
    ['a Head left without its beacon', (d) => {
      d.outputs[0].assets = {};
    }, 'p-leg-not-at-the-position/beacon-kept-from-its-head'],
    ['a leg premium over the quote', (d) => {
      const leg = decodePlutusData((d.outputs[2].datum as { cbor: string }).cbor) as PlutusConstr;
      leg.fields[2] = 21_000_000n;
      d.outputs[2].datum = { kind: 'inline', cbor: bytesToHex(encodePlutusData(leg)) };
    }, 'sale-not-the-quote/premium'],
    ['a leg premium over the request', (d) => {
      const leg = decodePlutusData((d.outputs[2].datum as { cbor: string }).cbor) as PlutusConstr;
      leg.fields[2] = 21_000_000n;
      d.outputs[2].datum = { kind: 'inline', cbor: bytesToHex(encodePlutusData(leg)) };
    }, 'buyer-outflow-over-the-sale/leg-premiums-over-the-request'],
    ['a leg of another position', (d) => {
      const leg = decodePlutusData((d.outputs[2].datum as { cbor: string }).cbor) as PlutusConstr;
      leg.fields[4] = b('12'.repeat(28));
      d.outputs[2].datum = { kind: 'inline', cbor: bytesToHex(encodePlutusData(leg)) };
    }, 'p-leg-not-at-the-position/leg-not-of-the-position'],
    ['a leg under two ADA', (d) => {
      d.outputs[2].lovelace = 1_000_000n;
      d.outputs[5].lovelace += 49_000_000n;
    }, 'leg-under-the-min-utxo/leg-under-two-ada'],
    ['no leg', (d) => {
      d.outputs[2].assets = {};
    }, 'p-leg-not-at-the-position/no-leg'],
    ['a third name under the position', (d) => {
      d.mint[G3_PREVIEW_ADA.positionHash]['50' + '00'.repeat(28)] = 1n;
    }, 'p-leg-not-at-the-position/markers-not-the-heads'],
    ['a P marker of another position', (d) => {
      d.outputs[1].assets = { [G3_PREVIEW_ADA.positionHash]: { ['50' + '13'.repeat(28)]: 1n } };
    }, 'p-leg-not-at-the-position/p-leg-without-the-p-marker'],
    ['a P-leg datum that is no policy', (d) => {
      d.outputs[1].datum = { kind: 'inline', cbor: '00' };
    }, 'p-leg-not-at-the-position/p-leg-datum-unreadable'],
    ['a fee past a maximal transaction', (d) => {
      d.fee = 10n ** 10n;
    }, 'buyer-outflow-over-the-sale/fee-over-the-max'],
    ['no total collateral', (d) => {
      d.totalCollateral = null;
    }, 'collateral-not-the-buyers/total-collateral-absent'],
    ['unnamed collateral', (d) => {
      d.collateral = [HEAD];
    }, 'collateral-not-the-buyers/collateral-not-named'],
    ['a collateral return over what it nets', (d) => {
      (d.collateralReturn as { lovelace: bigint }).lovelace -= 1n;
    }, 'phase-one/total-collateral-not-held'],
    ['collateral that nets nothing', (d) => {
      (d.collateralReturn as { lovelace: bigint }).lovelace = 396861557n;
    }, 'phase-one/collateral-short'],
    ['an output under its min-UTxO', (d) => {
      d.outputs[5].lovelace -= 1n;
      d.outputs.push({ address: d.outputs[5].address, lovelace: 1n, assets: {}, datum: null, scriptRef: null });
    }, 'phase-one/output-under-min-utxo'],
    ['no output to the treasury', (d) => {
      d.outputs[4].address = '60' + '77'.repeat(28);
    }, 'protocol-fee-short/fee-output-missing'],
    ['an output on mainnet', (d) => {
      d.outputs[5].address = '01' + d.outputs[5].address.slice(2);
    }, 'sale-off-the-network/output-network'],
    ['a withdrawal on mainnet', (d) => {
      d.withdrawals[0].networkId = 1;
    }, 'sale-off-the-network/withdrawal-network'],
    ['no lower validity bound', (d) => {
      d.validFromSlot = null;
    }, 'sale-window/validity-unbounded'],
    ['a fee under the rate', (d) => {
      d.outputs[4].lovelace = 300_000n;
      d.outputs[5].lovelace += 837_840n;
    }, 'protocol-fee-short/fee-under-the-rate'],
    ['a fee output without the digest', (d) => {
      d.outputs[4].datum = null;
    }, 'protocol-fee-short/fee-output-without-the-digest'],
    ['no donation', (d) => {
      d.donation = null;
      d.outputs[5].lovelace += 100_000n;
    }, 'donation-short/treasury-donation'],
    ['an ADA skimmed from the change', (d) => {
      d.outputs[5].lovelace -= 1_000_000n;
      d.outputs.push({ address: '60' + '77'.repeat(28), lovelace: 1_000_000n, assets: {}, datum: null, scriptRef: null });
    }, 'buyer-outflow-over-the-sale/net-lovelace-outflow'],
    ['a foreign required signer', (d) => {
      d.requiredSigners.push('88'.repeat(28));
    }, 'sale-foreign-purpose/foreign-required-signer'],
    ['a foreign withdrawal', (d) => {
      d.withdrawals.push({ credential: { kind: 'script', hash: '99'.repeat(28) }, networkId: 0, amount: 0n });
    }, 'sale-foreign-purpose/foreign-withdrawal'],
    ['a withdrawal of the buyer', (d) => {
      d.withdrawals.push({ credential: { kind: 'key', hash: BUYER_STAKE }, networkId: 0, amount: 1n });
    }, 'buyer-outflow-over-the-sale/buyer-withdrawal'],
    ['a foreign mint', (d) => {
      d.mint['aa'.repeat(28)] = { '': 1n };
    }, 'buyer-outflow-over-the-sale/foreign-mint'],
    ['a span past twenty minutes', (d) => {
      d.validFromSlot = (d.validToSlot as bigint) - 1201n;
    }, 'sale-window/span-over-the-max'],
    ['an upper bound past the reading', (d) => {
      d.validToSlot = 128388000n;
    }, 'sale-window/valid-until-before-the-upper-bound'],
    ['a collateral return to another key', (d) => {
      (d.collateralReturn as { address: string }).address = '60' + '77'.repeat(28);
    }, 'collateral-not-the-buyers/collateral-return-off-the-buyer'],
    ['total collateral over the bound', (d) => {
      d.totalCollateral = (d.totalCollateral as bigint) + 1n;
    }, 'collateral-not-the-buyers/total-collateral-over-the-bound'],
    ['the mainnet id', (d) => {
      d.networkId = 1;
    }, 'sale-off-the-network/body-network'],
    ['a fee under the ledger minimum', (d) => {
      d.fee -= 10_000n;
      d.outputs[5].lovelace += 10_000n;
    }, 'phase-one/fee-under-the-min'],
    ['an unbalanced body', (d) => {
      d.outputs[5].lovelace += 1n;
    }, 'phase-one/value-not-conserved'],
    ['the table reference dropped', (d) => {
      d.referenceInputs = d.referenceInputs.filter((r) => !r.startsWith(TABLE));
    }, 'table-not-referenced/one-table'],
    ['the reading reference dropped', (d) => {
      d.referenceInputs = d.referenceInputs.filter((r) => !r.startsWith(READING));
    }, 'sale-window/reading-not-referenced'],
  ];

  it.each(mutants)('refuses %s', async (_what, edit, expected) => {
    const d = draft();
    edit(d);
    expect(await judged(written(d))).toContain(expected);
  });

  it.each([
    ['observed after the upper bound', 1n, 1795039743001n, 'sale-window/observed-after-the-upper-bound'],
    ['older than the class allows', 1n, 1795039743000n - 600_001n, 'sale-window/spot-older-than-the-class-allows'],
    ['a twelve-hour low above its spot', 3n, 150067n, 'sale-window/twelve-hour-low-above-spot'],
  ])('refuses a reading %s', async (_what, key, value, expected) => {
    expect(await judged(sale.prepared, { resolved: readingWith(key, value) })).toContain(expected);
  });

  const holding: Array<[string, (o: ResolvedOutput) => void, string]> = [
    ['a token', (o) => { o.assets = { ['ab'.repeat(28)]: { '': 1n } }; }, 'collateral-not-the-buyers/collateral-holds-a-token'],
    ['a reference script', (o) => { o.referenceScript = { hash: 'ab'.repeat(28), size: 10 }; }, 'collateral-not-the-buyers/collateral-holds-a-reference-script'],
  ];

  it.each(holding)('refuses collateral holding %s', async (_what, edit, expected) => {
    expect(await judged(sale.prepared, { resolved: resolvedWith(FUNDING.slice(0, 16), edit) })).toContain(expected);
  });

  it('refuses a buyer token the sale takes', async () => {
    const r = resolvedWith(FUNDING.slice(0, 16), (o) => { o.assets = { ['ab'.repeat(28)]: { '': 1n } }; });
    expect(await judged(sale.prepared, { resolved: r })).toContain('buyer-outflow-over-the-sale/net-asset-outflow');
  });

  it('refuses a Head that holds no beacon', async () => {
    const r = resolvedWith(HEAD.slice(0, 16), (o) => { o.assets = {}; });
    expect(await judged(sale.prepared, { resolved: r })).toContain('p-leg-not-at-the-position/head-not-spent');
  });

  it('refuses a key input the request does not name', async () => {
    const d = draft();
    const extra = 'cd'.repeat(32) + '#0';
    d.inputs.push(extra);
    const key: ResolvedOutput = { address: '60' + 'ef'.repeat(28), lovelace: 5_000_000n, assets: {}, datum: null, referenceScript: null };
    expect(await judged(written(d), { resolved: { ...resolved, [extra]: key } })).toContain('buyer-outflow-over-the-sale/unnamed-buyer-input');
  });

  it('refuses more legs than the instance takes, a body past the size limit and units past the budget', async () => {
    expect(await judged(sale.prepared, { instance: { ...G3_PREVIEW_ADA, maxLegs: 0 } })).toContain('p-leg-not-at-the-position/legs-over-the-max');
    expect(await judged(sale.prepared, { params: { ...PARAMS, maxTxSize: 1000 } })).toContain('phase-one/size-over-the-max');
    expect(await judged(sale.prepared, { params: { ...PARAMS, maxTxMem: 1000n } })).toContain('phase-one/units-over-the-max');
  });

  it('refuses a witness set carrying more than redeemers', async () => {
    expect(await judged(withWitnessKey(sale.prepared, 4, { t: 'array', items: [] }))).toContain('sale-foreign-purpose/foreign-witness');
  });

  it('refuses a sale whose inputs the buyer cannot resolve', async () => {
    expect(await judged(sale.prepared, { resolved: without(FUNDING.slice(0, 16)) })).toEqual(
      expect.arrayContaining(['sale-foreign-purpose/input-unresolved', 'buyer-outflow-over-the-sale/net-lovelace-outflow']),
    );
  });

  it('refuses charges over the quote', async () => {
    const quote = await theQuote();
    expect(await judged(sale.prepared, { quote: { ...quote, needs: { ...quote.needs, unit: quote.needs.unit - 1n } } })).toContain(
      'sale-not-the-quote/charges',
    );
  });

  it('refuses a certificate and a field the codec does not read', async () => {
    const cert: CborItem = { t: 'array', items: [{ t: 'array', items: [{ t: 'int', v: 0n }, { t: 'array', items: [{ t: 'int', v: 0n }, { t: 'bytes', v: hexToBytes(BUYER_STAKE) }] }] }] };
    expect(await judged(withBodyKey(sale.prepared, 4, cert))).toContain('sale-foreign-purpose/certificate');
    expect(await judged(withBodyKey(sale.prepared, 19, { t: 'map', entries: [] }))).toContain('sale-foreign-purpose/foreign-body-field');
  });

  it('refuses a script input that is neither the book nor a Head', async () => {
    const d = draft();
    const foreign = 'ab'.repeat(32) + '#0';
    d.inputs.push(foreign);
    const extra: ResolvedOutput = { address: '70' + 'cd'.repeat(28), lovelace: 5_000_000n, assets: {}, datum: null, referenceScript: null };
    expect(await judged(written(d), { resolved: { ...resolved, [foreign]: extra } })).toContain('sale-foreign-purpose/foreign-script-input');
  });
});
