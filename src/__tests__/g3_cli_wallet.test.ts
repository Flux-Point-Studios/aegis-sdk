// The wallet a gen-3 CLI spends from, held to the Python tools (fixtures/g3_cli_vectors.json):
// every Koios POST its listing makes and the listing it reads, the richest rows of a padded
// wallet, the funding a spend takes and the collateral it puts up.

import { describe, expect, it } from 'vitest';
import { BookRefusal, resolvedOutputsFromKoios } from '../book';
import { g3CollateralOf, g3FundingFor, koiosRichestRows, readWalletOutputs } from '../book_wallet';
import type { MinimalFetch } from '../fetch_quote';
import type { KoiosUtxo } from '../koios';
import vectors from './fixtures/g3_cli_vectors.json';

const V = vectors as any;
const BASE = 'https://koios.test/api/v1';

describe("a wallet's listing", () => {
  for (const l of V.listings) {
    it(`of ${l.rows.length} rows asks Koios what richest() asks and reads the same listing`, async () => {
      const asked: Array<{ path: string; body: unknown }> = [];
      const fetchImpl = (async (url: string, init: { body: string }) => {
        const at = asked.length;
        asked.push({ path: url.slice(BASE.length), body: JSON.parse(init.body) });
        const answer = l.asked[at] === undefined ? [] : answerFor(l, at);
        return { ok: true, status: 200, json: async () => answer };
      }) as unknown as MinimalFetch;
      const read = await readWalletOutputs(V.public.address, { network: 'preview', koios: BASE, fetchImpl, pageRows: 3, maxPages: 2 });
      expect(asked).toEqual(l.asked);
      expect(Object.keys(read.outputs)).toEqual(l.listing);
      expect(read.cut).toBe(l.cut);
    });
  }
});

/** The rows the Python fake answered the POST at `at` with, replayed by the rows it served. */
function answerFor(l: any, at: number): KoiosUtxo[] {
  return served[`${l.rows.length}:${at}`];
}

const served: Record<string, KoiosUtxo[]> = {};
// The recorded listings carry the POSTs, not their answers: rebuild each answer from the rows
// the way the Python fake served them, then hold the replay to the recorded POSTs.
for (const l of V.listings) {
  l.asked.forEach((a: any, at: number) => {
    served[`${l.rows.length}:${at}`] = koiosAnswer(l.rows, a.path);
  });
}

function koiosAnswer(rows: KoiosUtxo[], path: string): KoiosUtxo[] {
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  if (q.has('value')) {
    const digits = q.get('value')!.length - 'like.'.length;
    let held = rows.filter((r) => String(r.value).length === digits)
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)) || (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : a.tx_index - b.tx_index));
    const or = q.get('or');
    if (or) {
      const v = or.split(',')[0].slice('(value.lt.'.length);
      const t = or.split('tx_hash.gt.')[1].split(')')[0];
      const ix = Number(or.split('tx_index.gt.')[1].split(')')[0]);
      held = held.filter((r) => r.value < v || (r.value === v && r.tx_hash > t) || (r.value === v && r.tx_hash === t && r.tx_index > ix));
    }
    return held.slice(0, Number(q.get('limit')));
  }
  if (!q.has('limit')) return rows;
  let held = [...rows].sort((a, b) => (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : a.tx_index - b.tx_index));
  const or = q.get('or');
  if (or) {
    const t = or.split('tx_hash.gt.')[1].split(',')[0].replace(/\)$/, '');
    const ix = Number(or.split('tx_index.gt.')[1].replace(/\)+$/, ''));
    held = held.filter((r) => r.tx_hash > t || (r.tx_hash === t && r.tx_index > ix));
  }
  return held.slice(0, Number(q.get('limit')));
}

describe('the richest rows of a padded listing', () => {
  for (const r of V.ranked) {
    it(`at ${r.rows} rows asks each page Python asks and reads its rows`, async () => {
      let at = 0;
      const read = await koiosRichestRows(async (query) => {
        const want = r.asked[at++];
        expect(query).toBe(want.query);
        return want.answer;
      }, r.rows, '/address_utxos', r.page_rows);
      expect(at).toBe(r.asked.length);
      expect(read.rows.map((x) => `${x.tx_hash}#${x.tx_index}`)).toEqual(r.read);
      expect(read.cut).toBe(r.cut);
    });
  }
});

describe('the funding a spend takes', () => {
  const wallet = resolvedOutputsFromKoios(V.funding.rows);

  it('puts up the richest UTxO of lovelace alone as collateral', () => {
    expect(g3CollateralOf(wallet)).toBe(V.funding.collateral);
    const bare = Object.fromEntries(V.funding.bare.map((ref: string) => [ref, wallet[ref]]));
    let refused: BookRefusal | null = null;
    try {
      g3CollateralOf(bare);
    } catch (e) {
      refused = e as BookRefusal;
    }
    expect({ refused: refused?.refusal, detail: refused?.detail }).toEqual(V.funding.no_collateral);
  });

  it('takes no more than one request names, holds the change reserve, and stands 5 ADA as collateral', () => {
    const crowded = resolvedOutputsFromKoios(V.funding.crowded.rows);
    expect(g3CollateralOf(crowded)).toBe(V.funding.crowded.collateral);
    for (const c of V.funding.crowded.cases) expect(Object.keys(g3FundingFor(crowded, BigInt(c.lovelace), {}))).toEqual(c.chosen);
  });

  for (const c of V.funding.cases) {
    it(`for ${c.lovelace} lovelace and ${JSON.stringify(c.tokens)} takes the outputs Python takes`, () => {
      const tokens = Object.fromEntries(Object.entries(c.tokens).map(([u, q]) => [u, BigInt(q as number)]));
      expect(Object.keys(g3FundingFor(wallet, BigInt(c.lovelace), tokens, new Set(c.last)))).toEqual(c.chosen);
    });
  }
});
