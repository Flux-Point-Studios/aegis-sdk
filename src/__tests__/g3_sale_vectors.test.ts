// verifyG3Sale against every sale Python's buy_g3_cover judged in its honest and tampered buys
// (fixtures/g3_sale_vectors.json, written by offchain/scripts/g3_sale_vectors.py at the commit it
// names): the ADA and USDCx instances, pinned and unpinned. An honest sale passes with no
// problem, a refused one is refused, and a refusal whose family both name is named the same.

import { describe, expect, it } from 'vitest';
import { g3Charges, verifyG3Sale } from '../book';
import type { G3CoverRequest, G3Instance, G3Quote, ResolvedOutput } from '../book';
import { bytesToHex } from '../cbor';
import { decodePlutusData, encodePlutusData } from '../plutus_data';
import type { PlutusConstr, PlutusData } from '../plutus_data';
import { decodeTransaction, encodeTransaction, txViewOf } from '../tx';
import type { ProtocolParams, TxDraft } from '../tx';
import vectors from './fixtures/g3_sale_vectors.json';

const V = vectors as any;
const big = (x: number) => BigInt(x);

const p = V.params;
const PARAMS: ProtocolParams = {
  minFeeA: big(p.min_fee_a), minFeeB: big(p.min_fee_b),
  priceMem: [big(p.price_mem[0]), big(p.price_mem[1])], priceSteps: [big(p.price_steps[0]), big(p.price_steps[1])],
  refScriptCostPerByte: [big(p.ref_script_cost_per_byte), 1n], coinsPerUtxoByte: big(p.coins_per_utxo_byte),
  maxTxSize: p.max_tx_size, maxValueSize: p.max_val_size, maxTxMem: big(p.max_tx_mem), maxTxSteps: big(p.max_tx_steps),
  collateralPercent: big(p.collateral_percent), costModelsV3: [],
};

function instanceOf(i: any): G3Instance {
  return {
    network: i.network, name: i.name, unit: i.unit, unitPolicy: i.unit_policy, unitName: i.unit_name,
    legCarrier: big(i.leg_carrier), liqwidHash: i.liqwid_hash, fxFeed: i.fx_feed, fxScale: big(i.fx_scale),
    rates: i.rates.map((r: any) => ({ policy: r.policy, name: r.name, statePolicy: r.state_policy, stateName: r.state_name,
      stateScript: r.state_script, floor: r.floor, liqDiv: big(r.liq_div) })),
    rows: [], positionHash: i.position_hash, bookHash: i.book_hash, tableHash: i.table_hash, tableName: i.table_name,
    accrualHash: i.accrual_hash, observerHash: i.observer_hash, beaconPolicy: i.beacon_policy, beaconName: i.beacon_name,
    treasury: i.treasury, publisherVkh: i.publisher_vkh, feeBps: big(i.fee_bps), donationBps: big(i.donation_bps),
    minPremium: big(i.min_premium), minLegPremium: big(i.min_leg_premium), minLegCoverage: big(i.min_leg_coverage),
    maxLegs: i.max_legs, heads: i.heads, refScripts: i.ref_scripts, sheets: i.sheets,
  };
}

function requestOf(r: any): G3CoverRequest {
  return { ...r, strike: big(r.strike), coverage: big(r.coverage), term_ms: big(r.term_ms), premium: big(r.premium),
    deposit: big(r.deposit) };
}

function quoteOf(a: any): G3Quote {
  return {
    unit: a.unit, available: a.available, legs: a.legs, coverage: big(a.coverage), premium: big(a.premium),
    loadedAsk: big(a.loaded_ask), pricedBy: a.priced_by, protocolFee: big(a.protocol_fee), feeLovelace: big(a.fee_lovelace),
    donationLovelace: big(a.donation_lovelace), needs: { unit: big(a.needs.unit), lovelace: big(a.needs.lovelace) },
    fx: a.fx === null ? null : big(a.fx), carriers: big(a.carriers), validForMs: a.valid_for_ms,
  };
}

function resolvedOf(rows: Record<string, any>): Record<string, ResolvedOutput> {
  const out: Record<string, ResolvedOutput> = {};
  for (const [ref, o] of Object.entries(rows)) {
    const assets: Record<string, Record<string, bigint>> = {};
    for (const [policy, names] of Object.entries(o.assets as Record<string, Record<string, number>>)) {
      assets[policy] = Object.fromEntries(Object.entries(names).map(([n, q]) => [n, big(q)]));
    }
    out[ref] = { address: o.address, lovelace: big(o.lovelace), assets, datum: o.datum,
      referenceScript: o.referenceScript && { hash: o.referenceScript.hash, size: o.referenceScript.size ?? 0 } };
  }
  return out;
}

/** The SDK code a Python problem's family is named by, where both verifiers name it. */
const FAMILIES: Array<[RegExp, string]> = [
  [/^insured-not-the-buyer:/, 'insured-not-the-buyer'],
  [/^p-leg-not-at-the-position:/, 'p-leg-not-at-the-position'],
  [/^collateral-not-the-buyers:/, 'collateral-not-the-buyers'],
  [/^sale-foreign-purpose:/, 'sale-foreign-purpose'],
  [/^sale-window:/, 'sale-window'],
  [/^p-leg-off-the-core-pins:/, 'p-leg-off-the-core-pins'],
  [/^protocol-fee-short:/, 'protocol-fee-short'],
  [/^buyer-outflow-over-the-sale:/, 'buyer-outflow-over-the-sale'],
  [/^reading-not-referenced:/, 'sale-window'],
  [/^(value-not-conserved|fee-under-the-ledger-minimum|script-without-a-source):/, 'phase-one'],
  [/^the bytes already carry a witness$/, 'sale-already-witnessed'],
  [/^the sale references no one table/, 'table-not-referenced'],
  [/^the Liqwid observer withdraws/, 'liqwid-observer-not-the-pin'],
  [/^the legs ask \d+, not the quoted/, 'sale-not-the-quote'],
  [/^the sale charges/, 'sale-not-the-quote'],
  [/^the buyer's addresses lose/, 'buyer-outflow-over-the-sale'],
];

const sales: any[] = V.sales;
const honest = sales.filter((s) => s.problems.length === 0);
const refused = sales.filter((s) => s.problems.length > 0);

describe('the recorded sales', () => {
  it('hold honest and refused sales of both instances, pinned and not', () => {
    expect(honest.some((s) => s.instance.name === 'ada')).toBe(true);
    expect(honest.some((s) => s.instance.name === 'usdcx' && s.request.pin === null)).toBe(true);
    expect(honest.some((s) => s.instance.name === 'usdcx' && s.request.pin !== null)).toBe(true);
    expect(refused.length).toBeGreaterThanOrEqual(20);
  });
});

describe('verifyG3Sale against buy_g3_cover.sale_problems', () => {
  sales.forEach((s, at) => {
    it(`${at} ${s.test}`, () => {
      const problems = verifyG3Sale({
        tx: s.tx, request: requestOf(s.request), quote: quoteOf(s.quote), instance: instanceOf(s.instance),
        resolved: resolvedOf(s.resolved), params: PARAMS,
      });
      if (s.problems.length === 0) {
        expect(problems).toEqual([]);
        return;
      }
      expect(problems.length).toBeGreaterThan(0);
      const codes = new Set(problems.map((x) => x.code));
      for (const py of s.problems as string[]) {
        const family = FAMILIES.find(([pattern]) => pattern.test(py));
        expect(family, py).toBeDefined();
        expect([...codes], py).toContain((family as [RegExp, string])[1]);
      }
    });
  });
});

const instances: Record<string, G3Instance> = Object.fromEntries(sales.map((s) => [s.instance.name, instanceOf(s.instance)]));

describe('g3Charges against g3.charges', () => {
  it('covers both instances and readings that do not divide', () => {
    const grid: any[] = V.charges;
    expect(new Set(grid.map((c) => c.instance))).toEqual(new Set(['ada', 'usdcx']));
    expect(grid.some((c) => c.fx === 3)).toBe(true);
  });

  (V.charges as any[]).forEach((c) => {
    it(`${c.instance} premium ${c.premium} at ${c.fx} with deposit ${c.deposit}`, () => {
      expect(g3Charges(big(c.premium), instances[c.instance], PARAMS, big(c.fx), big(c.deposit))).toEqual({
        protocolFee: big(c.charges.protocol_fee), feeLovelace: big(c.charges.fee_lovelace),
        donationLovelace: big(c.charges.donation_lovelace),
        needs: { unit: big(c.charges.needs.unit), lovelace: big(c.charges.needs.lovelace) },
      });
    });
  });
});

// One-field departures from the honest USDCx sales Python passed, each refused under its own name.
const named = (test: string) => honest.find((s) => s.test === test);
const UNPINNED = named('test_the_dry_run_judges_the_presented_sale_and_signs_nothing[usdcx]');
const PINNED = honest.find((s) => s.test.startsWith('test_a_pinned_sale_lands_with_the_instances_receipt'));
const USDCX = instances.usdcx;
const UNIT = USDCX.unitPolicy + USDCX.unitName;

interface Departure {
  draft?: (d: TxDraft) => void;
  resolved?: (r: Record<string, ResolvedOutput>) => void;
  request?: (r: G3CoverRequest) => void;
}

function judged(s: any, edit: Departure): string[] {
  const d = txViewOf(decodeTransaction(s.tx));
  edit.draft?.(d);
  const resolved = resolvedOf(s.resolved);
  edit.resolved?.(resolved);
  const request = requestOf(s.request);
  edit.request?.(request);
  return verifyG3Sale({ tx: bytesToHex(encodeTransaction(d)), request, quote: quoteOf(s.quote), instance: USDCX, resolved, params: PARAMS })
    .map((p) => `${p.code}/${p.conjunct}`);
}

function fxRef(r: Record<string, ResolvedOutput>): string {
  return Object.keys(r).find((ref) => r[ref].assets[USDCX.fxFeed]) as string;
}

function unitsAt(d: TxDraft, at: number, delta: bigint): void {
  const names = d.outputs[at].assets[USDCX.unitPolicy];
  names[USDCX.unitName] += delta;
}

function feeAt(d: TxDraft): number {
  return d.outputs.findIndex((o) => o.address === USDCX.treasury);
}

function changeAt(d: TxDraft): number {
  return d.outputs.length - 1;
}

const STRANGER = '5a'.repeat(28);

function withoutSource(r: Record<string, ResolvedOutput>, hash: string): void {
  for (const o of Object.values(r)) if (o.referenceScript?.hash === hash) o.referenceScript = null;
}

function withSpot(r: Record<string, ResolvedOutput>, spot: bigint): void {
  const o = r[fxRef(r)];
  const outer = decodePlutusData((o.datum as { cbor: string }).cbor) as PlutusConstr;
  const m = (outer.fields[0] as PlutusConstr).fields[0] as { map: Array<[PlutusData, PlutusData]> };
  m.map = m.map.map(([k, v]) => [k, k === 0n ? spot : v]);
  o.datum = { kind: 'inline', cbor: bytesToHex(encodePlutusData(outer)) };
}

describe('verifyG3Sale on the USDCx instance', () => {
  it('holds an honest pinned and unpinned sale to start from', () => {
    expect(UNPINNED && PINNED).toBeTruthy();
    expect(judged(UNPINNED, {})).toEqual([]);
    expect(judged(PINNED, {})).toEqual([]);
    expect(feeAt(txViewOf(decodeTransaction(UNPINNED.tx)))).toBeGreaterThan(0);
  });

  const departures: Array<[string, () => any, Departure, string]> = [
    ['an fx reading at another key', () => UNPINNED, { resolved: (r) => { r[fxRef(r)].address = '60' + '77'.repeat(28); } },
      'sale-window/fx-reading-not-referenced'],
    ['an fx reading without its feed token', () => UNPINNED, { resolved: (r) => { delete r[fxRef(r)].assets[USDCX.fxFeed]; } },
      'sale-window/fx-reading-not-referenced'],
    ['an fx reading of zero', () => UNPINNED, { resolved: (r) => withSpot(r, 0n) }, 'sale-window/fx-reading-not-referenced'],
    ['the fx reading unreferenced', () => UNPINNED, {
      draft: (d) => { d.referenceInputs = d.referenceInputs.filter((ref) => !resolvedOf(UNPINNED.resolved)[ref].assets[USDCX.fxFeed]); },
    }, 'sale-window/fx-reading-not-referenced'],
    ['a fee output short of the rate in units', () => UNPINNED, {
      draft: (d) => { unitsAt(d, feeAt(d), -1n); unitsAt(d, changeAt(d), 1n); },
    }, 'protocol-fee-short/fee-under-the-rate'],
    ['a unit over the sale', () => UNPINNED, {
      draft: (d) => { unitsAt(d, feeAt(d), 1n); unitsAt(d, changeAt(d), -1n); },
    }, 'buyer-outflow-over-the-sale/net-asset-outflow'],
    ['a pin to another receipt', () => PINNED, { request: (r) => { r.pin = { ...(r.pin as any), name: '01' }; } },
      'p-leg-off-the-core-pins/extension'],
    ['an unpinned request', () => PINNED, { request: (r) => { r.pin = null; } }, 'p-leg-off-the-core-pins/extension'],
    ['a pinned request', () => UNPINNED, { request: (r) => { r.pin = PINNED.request.pin; } }, 'p-leg-off-the-core-pins/extension'],
    ['the Liqwid withdrawal at a key', () => PINNED, {
      draft: (d) => { d.withdrawals = d.withdrawals.map((w) => (w.credential.hash === USDCX.liqwidHash ? { ...w, credential: { ...w.credential, kind: 'key' } } : w)); },
    }, 'liqwid-observer-not-the-pin/liqwid-withdrawal'],
    ['the Liqwid observer run twice', () => PINNED, {
      draft: (d) => { d.withdrawals.push({ ...(d.withdrawals.find((w) => w.credential.hash === USDCX.liqwidHash) as TxDraft['withdrawals'][number]) }); },
    }, 'liqwid-observer-not-the-pin/liqwid-withdrawal'],
    ['the Liqwid script without a source', () => PINNED, { resolved: (r) => withoutSource(r, USDCX.liqwidHash) },
      'phase-one/script-without-a-source'],
    ['the book script without a source', () => PINNED, { resolved: (r) => withoutSource(r, USDCX.bookHash) },
      'phase-one/script-without-a-source'],
    ['a mint under a policy nothing carries', () => PINNED, {
      draft: (d) => {
        d.mint = { ...d.mint, [STRANGER]: { '': 1n } };
        d.outputs[changeAt(d)].assets = { ...d.outputs[changeAt(d)].assets, [STRANGER]: { '': 1n } };
      },
    }, 'phase-one/script-without-a-source'],
  ];

  it.each(departures)('refuses %s', (_what, sale, edit, expected) => {
    expect(judged(sale(), edit)).toContain(expected);
  });

  it('takes a script source from a spent input as from a reference input', () => {
    const problems = judged(PINNED, {
      resolved: (r) => {
        const source = Object.values(r).find((o) => o.referenceScript?.hash === USDCX.bookHash) as ResolvedOutput;
        const spent = decodeTransaction(PINNED.tx).inputs.find((ref) => r[ref].address.slice(2, 58) === USDCX.bookHash) as string;
        r[spent].referenceScript = source.referenceScript;
        source.referenceScript = null;
      },
    });
    expect(problems).not.toContain('phase-one/script-without-a-source');
  });
});
