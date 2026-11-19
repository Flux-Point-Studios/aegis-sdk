// A buyer's or an underwriter's wallet as the gen-3 tools spend from it: every output at its
// address, read from Koios, or the richest of them once the listing runs past its pages,
// since anyone can lengthen it by paying the address; the outputs a spend takes; and the
// UTxO it puts up as collateral.

import { BookRefusal, resolvedOutputsFromKoios } from './book';
import type { ResolvedOutput } from './book';
import { ChainError } from './errors';
import { koiosHeaders } from './koios';
import type { KoiosReadOptions, KoiosUtxo } from './koios';
import type { MinimalFetch } from './fetch_quote';
import { CHAIN_FACTS } from './networks';

/** Rows Koios answers a listing page with at most. */
export const KOIOS_PAGE_ROWS = 1000;
/** The pages one listing may read before it is read for its richest rows instead. */
export const KOIOS_MAX_PAGES = 50;
/** The widest lovelace a row of a listing holds, in digits. */
const LOVELACE_DIGITS = 17;
const RICHEST_ORDER = 'value.desc,tx_hash.asc,tx_index.asc';
const KEY_PART = /^[0-9a-z_]+$/;
/** The most outputs one request names. */
export const KOIOS_UTXO_BATCH = 50;
/** What a spend's funding holds past what it pays: the fee and the change's min-UTxO. */
export const G3_CHANGE_RESERVE = 5_000_000n;
/** The least lovelace a UTxO of lovelace alone holds to stand as a sale's collateral. */
export const G3_COLLATERAL_FLOOR = 5_000_000n;

export interface WalletListingOptions extends KoiosReadOptions {
  /** Rows a page holds (Koios' 1000). */
  pageRows?: number;
  /** Pages a listing reads before it is read for its richest rows. */
  maxPages?: number;
}

/** The outputs at an address: every one, or the richest a read reached and `cut` true. */
export interface WalletListing {
  outputs: Record<string, ResolvedOutput>;
  cut: boolean;
}

/** A form value as Python's urllib.parse.quote_plus writes it. */
function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

function query(params: Array<[string, string | number]>): string {
  return params.map(([k, v]) => `${quotePlus(k)}=${quotePlus(String(v))}`).join('&');
}

async function post(opts: KoiosReadOptions, path: string, body: unknown): Promise<KoiosUtxo[]> {
  const f: MinimalFetch | undefined = opts.fetchImpl ?? (globalThis as { fetch?: MinimalFetch }).fetch;
  if (!f) throw new ChainError('UNKNOWN', 'no fetch available: pass opts.fetchImpl');
  const res = await f(`${opts.koios ?? CHAIN_FACTS[opts.network].koios}${path}`, {
    method: 'POST',
    headers: koiosHeaders(opts),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ChainError('UNKNOWN', `Koios ${path.split('?')[0]} answered HTTP ${res.status}`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new ChainError('UNKNOWN', `Koios ${path.split('?')[0]} answered no row listing`);
  return rows as KoiosUtxo[];
}

function outOfOrder(listing: string, key: unknown[], last: unknown[]): never {
  throw new ChainError('UNKNOWN', `koios ${listing} answered ${JSON.stringify(key)} after ${JSON.stringify(last)}, out of the order it was asked for`);
}

function rowKey(row: KoiosUtxo, listing: string): [string, number] {
  if (typeof row.tx_hash !== 'string' || !KEY_PART.test(row.tx_hash) || !Number.isSafeInteger(row.tx_index)) {
    throw new ChainError('UNKNOWN', `koios ${listing} answered a row whose key no page continues past`);
  }
  return [row.tx_hash, row.tx_index];
}

function after(a: [string, number], b: [string, number]): boolean {
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

class ListingTooLong extends Error {}

/** Every row of an output listing: one answer under a page, else pages on the out-ref order. */
async function wholeListing(opts: WalletListingOptions, path: string, body: unknown): Promise<KoiosUtxo[]> {
  const pageRows = opts.pageRows ?? KOIOS_PAGE_ROWS;
  const first = await post(opts, path, body);
  if (first.length < pageRows) return first;
  const paged = `${path}?limit=${pageRows}&order=tx_hash.asc,tx_index.asc`;
  const rows: KoiosUtxo[] = [];
  let last: [string, number] | null = null;
  for (let page = 0; page < (opts.maxPages ?? KOIOS_MAX_PAGES); page++) {
    const past: string = last === null ? '' : `&or=(tx_hash.gt.${last[0]},and(tx_hash.eq.${last[0]},tx_index.gt.${last[1]}))`;
    const read = await post(opts, paged + past, body);
    for (const row of read) {
      const key = rowKey(row, path);
      if (last !== null && !after(key, last)) outOfOrder(path, key, last);
      last = key;
    }
    rows.push(...read);
    if (read.length < pageRows) return rows;
  }
  throw new ListingTooLong(path);
}

function richestKey(row: KoiosUtxo, digits: number, listing: string): [string, string, number] {
  const value = row.value as unknown;
  if (typeof value !== 'string' || value.length !== digits || !/^[0-9]+$/.test(value) ||
    typeof row.tx_hash !== 'string' || !KEY_PART.test(row.tx_hash) || !Number.isSafeInteger(row.tx_index)) {
    throw new ChainError('UNKNOWN', `koios ${listing} answered a row keyed among ${digits}-digit lovelace, which no page continues past`);
  }
  return [value, row.tx_hash, row.tx_index];
}

/**
 * At most `rows` rows of a Koios output listing, the richest first, and whether rows were left
 * unread. Koios orders lovelace as text, so each length of it is asked in turn, longest first,
 * through a PostgREST `like` of one `_` a digit, continued past the last row read. `ask`
 * answers one page's query string, form-encoded as Python's urlencode writes it.
 */
export async function koiosRichestRows(
  ask: (query: string) => Promise<KoiosUtxo[]>,
  rows: number,
  listing: string,
  pageRows: number = KOIOS_PAGE_ROWS,
): Promise<{ rows: KoiosUtxo[]; cut: boolean }> {
  const read: KoiosUtxo[] = [];
  for (let digits = LOVELACE_DIGITS; digits > 0; digits--) {
    let last: [string, string, number] | null = null;
    for (;;) {
      if (read.length >= rows) return { rows: read, cut: true };
      const limit = Math.min(pageRows, rows - read.length);
      const params: Array<[string, string | number]> = [['value', `like.${'_'.repeat(digits)}`], ['order', RICHEST_ORDER], ['limit', limit]];
      if (last !== null) {
        const [v, t, i] = last;
        params.push(['or', `(value.lt.${v},and(value.eq.${v},tx_hash.gt.${t}),and(value.eq.${v},tx_hash.eq.${t},tx_index.gt.${i}))`]);
      }
      const page = await ask(query(params));
      for (const row of page) {
        const key = richestKey(row, digits, listing);
        if (last !== null && !(key[0] < last[0] || (key[0] === last[0] && (key[1] > last[1] || (key[1] === last[1] && key[2] > last[2]))))) {
          outOfOrder(listing, key, last);
        }
        last = key;
      }
      read.push(...page);
      if (page.length < limit) break;
    }
  }
  return { rows: read, cut: false };
}

/**
 * The outputs at `address`: the whole listing while it fits its pages, else the richest rows
 * those pages hold and `cut`, each row left out holding no more lovelace than any read.
 */
export async function readWalletOutputs(address: string, opts: WalletListingOptions): Promise<WalletListing> {
  const body = { _addresses: [address], _extended: true };
  try {
    return { outputs: resolvedOutputsFromKoios(await wholeListing(opts, '/address_utxos', body)), cut: false };
  } catch (e) {
    if (!(e instanceof ListingTooLong)) throw e;
  }
  const pageRows = opts.pageRows ?? KOIOS_PAGE_ROWS;
  const { rows, cut } = await koiosRichestRows(
    (q) => post(opts, `/address_utxos?${q}`, body),
    (opts.maxPages ?? KOIOS_MAX_PAGES) * pageRows,
    '/address_utxos',
    pageRows,
  );
  return { outputs: resolvedOutputsFromKoios(rows), cut };
}

/** What a set of outputs holds: its lovelace and each token by policy and name, in the order first held. */
export function heldBy(outputs: Iterable<ResolvedOutput>): { lovelace: bigint; tokens: Record<string, bigint> } {
  let lovelace = 0n;
  const tokens: Record<string, bigint> = {};
  for (const o of outputs) {
    lovelace += o.lovelace;
    for (const [p, names] of Object.entries(o.assets)) {
      for (const [n, q] of Object.entries(names)) tokens[p + n] = (tokens[p + n] ?? 0n) + q;
    }
  }
  for (const unit of Object.keys(tokens)) if (tokens[unit] === 0n) delete tokens[unit];
  return { lovelace, tokens };
}

/**
 * The wallet's outputs a spend takes: the richest in lovelace first and the out-refs `last`
 * names after every other, until they hold `tokens` and `lovelace` beside G3_CHANGE_RESERVE;
 * the whole wallet, up to what one request names, when nothing less does, for the builder to
 * answer how far it falls short.
 */
export function g3FundingFor(
  wallet: Record<string, ResolvedOutput>,
  lovelace: bigint,
  tokens: Record<string, bigint>,
  last: ReadonlySet<string> = new Set(),
): Record<string, ResolvedOutput> {
  const ordered = Object.keys(wallet).sort((a, b) => {
    const la = last.has(a) ? 1 : 0;
    const lb = last.has(b) ? 1 : 0;
    if (la !== lb) return la - lb;
    const d = wallet[b].lovelace - wallet[a].lovelace;
    if (d !== 0n) return d > 0n ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }).slice(0, KOIOS_UTXO_BATCH);
  const chosen: Record<string, ResolvedOutput> = {};
  for (const ref of ordered) {
    const held = heldBy(Object.values(chosen));
    if (held.lovelace >= lovelace + G3_CHANGE_RESERVE && Object.entries(tokens).every(([u, q]) => (held.tokens[u] ?? 0n) >= q)) break;
    chosen[ref] = wallet[ref];
  }
  return chosen;
}

/** The wallet's richest UTxO of lovelace alone, at G3_COLLATERAL_FLOOR or over. */
export function g3CollateralOf(wallet: Record<string, ResolvedOutput>): string {
  const plain = Object.keys(wallet)
    .filter((ref) => Object.keys(heldBy([wallet[ref]]).tokens).length === 0 && wallet[ref].lovelace >= G3_COLLATERAL_FLOOR)
    .sort((a, b) => {
      const d = wallet[b].lovelace - wallet[a].lovelace;
      if (d !== 0n) return d > 0n ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (!plain.length) {
    throw new BookRefusal('no-collateral', `the wallet holds no UTxO of lovelace alone at ${G3_COLLATERAL_FLOOR} or over`);
  }
  return plain[0];
}
