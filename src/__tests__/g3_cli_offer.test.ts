// An underwriter's offers against the Python tool's (fixtures/g3_cli_vectors.json): the offer
// each ask names or the refusal it meets, its output at the book, what the CLI prints of it,
// and the judgement of the hosted builder's post of it, honest and with each departure.

import { describe, expect, it } from 'vitest';
import { BookRefusal, G3_INSTANCES, resolvedOutputsFromKoios } from '../book';
import { G3_STARTER, g3Offer, g3OfferAddress, g3OfferOutput, g3OfferSummary, g3PostProblems } from '../book_offer';
import type { G3OfferAsk } from '../book_offer';
import { addressBytes } from '../address';
import { g3AddressView } from '../book_buyer';
import { bytesToHex } from '../cbor';
import { protocolParamsFromCli } from '../tx';
import cli from './fixtures/preview_protocol_params.json';
import vectors from './fixtures/g3_cli_vectors.json';

const V = vectors as any;
const PARAMS = protocolParamsFromCli(cli.response);
const preview = G3_INSTANCES.preview!;
const NOW = BigInt(V.now_ms);
const OWNER: string = V.public.payment_vkh;
const STAKE: string = (g3AddressView(V.public.address).stake as { key: string }).key;

const pair = (x: [number, number] | undefined) => x && ([BigInt(x[0]), BigInt(x[1])] as const);
const opt = (x: number | undefined) => (x === undefined ? undefined : BigInt(x));

function askOf(a: any): G3OfferAsk {
  return {
    label: a.label, feeds: a.feeds, size: BigInt(a.size), class: a.class, depth: pair(a.depth), termDays: pair(a.term_days),
    loadBps: opt(a.load_bps), minFill: opt(a.min_fill), maxFill: opt(a.max_fill), sheet: a.sheet, lovelace: opt(a.lovelace),
    receipts: opt(a.receipts),
  };
}

/** JSON with every bigint as its number, the shape the Python vectors hold. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));

describe('an offer', () => {
  V.offers.forEach((o: any, at: number) => {
    it(`${at} ${o.instance} ${JSON.stringify(o.ask)}`, () => {
      const inst = preview[o.instance];
      let made;
      try {
        made = g3Offer(inst, askOf(o.ask), OWNER, NOW, V.sheets.packed);
      } catch (e) {
        if (!(e instanceof BookRefusal)) throw e;
        expect({ refused: e.refusal, detail: e.detail }).toEqual({ refused: o.refused, detail: o.detail });
        return;
      }
      expect(o.refused).toBeUndefined();
      expect(plain(made)).toEqual(o.ok);
      const out = g3OfferOutput(inst, made, STAKE);
      expect(g3OfferAddress(inst, STAKE)).toBe(o.output.address);
      expect(out.address).toBe(bytesToHex(addressBytes(o.output.address)));
      expect(out.datum).toEqual({ kind: 'inline', cbor: o.output.datum.inline });
      expect(plain(g3OfferSummary(made))).toEqual(o.output.summary);
    });
  });

  it('starts each instance with the starter set the Python tool posts', () => {
    const starters = V.offers.filter((o: any) => o.ask.label);
    expect(starters.map((o: any) => [o.instance, o.ask])).toEqual(
      Object.entries(G3_STARTER).flatMap(([name, asks]) => asks.map((a) => [name, plain({
        label: a.label, feeds: a.feeds, size: a.size, ...(a.depth && { depth: a.depth }), ...(a.termDays && { term_days: a.termDays }),
        ...(a.loadBps !== undefined && { load_bps: a.loadBps }), ...(a.receipts !== undefined && { receipts: a.receipts }),
      })])),
    );
  });
});

describe("the hosted builder's post", () => {
  const wallet = bytesToHex(addressBytes(V.public.address));
  const funded: Record<string, any> = {};
  for (const p of V.posts) if (p.funding_rows) funded[p.instance] = resolvedOutputsFromKoios(p.funding_rows);

  V.posts.forEach((p: any) => {
    it(`${p.instance} ${p.label}`, () => {
      const offer = {
        address: bytesToHex(addressBytes(p.offer.address)), lovelace: BigInt(p.offer.lovelace),
        assets: Object.fromEntries(Object.entries(p.offer.tokens).reduce((m: Map<string, Record<string, bigint>>, [u, q]) =>
          m.set(u.slice(0, 56), { ...(m.get(u.slice(0, 56)) ?? {}), [u.slice(56)]: BigInt(q as number) }), new Map())),
        datum: { kind: 'inline' as const, cbor: p.offer.datum.inline }, scriptRef: null,
      };
      const funding = funded[p.instance];
      expect(Object.keys(funding).sort()).toEqual(p.funding);
      const problems = g3PostProblems(p.cbor, offer, funding, wallet, PARAMS);
      expect(problems.length).toBe(p.problems.length);
      problems.forEach((x, i) => {
        if (p.problems[i].startsWith('value-not-conserved:')) expect(x.split(':')[0]).toBe('value-not-conserved');
        else expect(x).toBe(p.problems[i]);
      });
    });
  });
});
