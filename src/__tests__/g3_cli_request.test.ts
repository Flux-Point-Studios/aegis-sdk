// The buyer CLI's instances and cover requests against the Python tools' own answers
// (fixtures/g3_cli_vectors.json, written by offchain/scripts/g3_cli_vectors.py at the commit it
// names): every request, its hash and the reservation the wallet signs, byte for byte.

import { describe, expect, it } from 'vitest';
import { BookRefusal, G3_INSTANCES, G3_PREVIEW_FEEDS, canonicalJson, g3RequestHash, g3ReservationPayload } from '../book';
import type { G3AddressView, G3CoverRequest, G3Instance } from '../book';
import { g3AddressView, g3CoverRequest, g3PayoutOf } from '../book_buyer';
import { protocolParamsFromCli } from '../tx';
import cli from './fixtures/preview_protocol_params.json';
import vectors from './fixtures/g3_cli_vectors.json';

const PARAMS = protocolParamsFromCli(cli.response);
const V = vectors as any;
const preview = G3_INSTANCES.preview!;

function refusal(call: () => unknown): { refused: string; detail: unknown } | null {
  try {
    call();
    return null;
  } catch (e) {
    if (e instanceof BookRefusal) return { refused: e.refusal, detail: e.detail };
    throw e;
  }
}

describe('the preview instances', () => {
  it('are the launch record joined to its vectors', () => {
    for (const name of ['ada', 'usdcx']) {
      const py = V.instances[name];
      const ts: G3Instance = preview[name];
      expect({
        name: ts.name, unit: ts.unit, unit_policy: ts.unitPolicy, unit_name: ts.unitName, position_hash: ts.positionHash,
        book_hash: ts.bookHash, table_hash: ts.tableHash, table_name: ts.tableName, accrual_hash: ts.accrualHash,
        observer_hash: ts.observerHash, beacon_policy: ts.beaconPolicy, beacon_name: ts.beaconName,
        publisher_vkh: ts.publisherVkh, fee_bps: Number(ts.feeBps), donation_bps: Number(ts.donationBps),
        min_premium: Number(ts.minPremium), min_leg_premium: Number(ts.minLegPremium),
        min_leg_coverage: Number(ts.minLegCoverage), max_legs: ts.maxLegs, leg_carrier: Number(ts.legCarrier),
        liqwid_hash: ts.liqwidHash, fx_feed: ts.fxFeed, fx_scale: Number(ts.fxScale), heads: ts.heads,
        ref_scripts: ts.refScripts, sheets: ts.sheets,
        rates: ts.rates.map((r) => ({ floor: r.floor, liq_div: Number(r.liqDiv), name: r.name, policy: r.policy,
          state_name: r.stateName, state_policy: r.statePolicy, state_script: r.stateScript })),
        treasury: ts.treasury,
      }).toEqual({ ...py, treasury: '00' + py.treasury.payment.key + py.treasury.stake.key });
      expect(ts.rows).toEqual(V.sheets.rows[name].map((r: any) => ({ feed: r.feed, class: r.class, kind: r.kind, sheet: r.sheet })));
    }
    expect(G3_PREVIEW_FEEDS).toEqual(V.sheets.feeds);
  });

  it('price at the parameters the Python tools read', () => {
    expect(PARAMS.coinsPerUtxoByte).toBe(BigInt(V.params.coins_per_utxo_byte));
    expect(PARAMS.minFeeA).toBe(BigInt(V.params.min_fee_a));
    expect(PARAMS.minFeeB).toBe(BigInt(V.params.min_fee_b));
    expect(PARAMS.maxTxSize).toBe(V.params.max_tx_size);
  });
});

describe('where the cover pays', () => {
  it('is a staked wallet itself, never a bare key or a pointer', () => {
    for (const { view, payout } of V.payouts) expect(g3PayoutOf(view as G3AddressView)).toEqual(payout);
  });

  it('reads the wallet address as the routes name it', () => {
    const view = g3AddressView(V.public.address);
    expect(view).toEqual({ payment: { key: V.public.payment_vkh }, stake: view.stake });
    expect(V.requests[0].payout).toEqual(view);
  });
});

describe('a cover request', () => {
  for (const c of V.requests) {
    it(`${c.instance} ${c.args.feed} ${c.args.cls}${c.args.pin ? ' pinned' : ''}`, () => {
      const build = () => g3CoverRequest(
        preview[c.instance],
        { feed: c.args.feed, class: c.args.cls, strike: BigInt(c.args.strike), coverage: BigInt(c.args.coverage),
          termDays: BigInt(c.args.term_days), pin: c.args.pin },
        { insured: c.insured, payout: c.payout, funding: c.funding, collateral: c.collateral },
        PARAMS,
      );
      if (c.refused) {
        expect(refusal(build)).toEqual({ refused: c.refused, detail: c.detail });
        return;
      }
      const request: G3CoverRequest = build();
      expect(canonicalJson(request)).toBe(c.canonical);
      expect(g3RequestHash(request)).toBe(c.hash);
      expect(g3ReservationPayload({ ...request, premium: 12_345_678n })).toBe(c.reservation);
    });
  }
});
