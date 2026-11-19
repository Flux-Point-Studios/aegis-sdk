// The aegis-book command against a fake Koios and API: what it refuses before reading anything,
// the ask a post names (the Python tool's _ask, fixtures/g3_cli_vectors.json), whoami, and a
// quote whose request and printed line equal the Python CLI's.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookRefusal, canonicalJson } from '../book';
import { askOf, main, parseArgs } from '../node/cli';
import type { CliDeps } from '../node/cli';
import params from './fixtures/preview_protocol_params.json';
import vectors from './fixtures/g3_cli_vectors.json';

const V = vectors as any;
const KOIOS = 'https://preview.koios.rest/api/v1';
const API = 'http://api.test';

function walletDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-book-'));
  writeFileSync(join(dir, 'mnemonic.txt'), V.mnemonic);
  writeFileSync(join(dir, 'public.json'), JSON.stringify({ network: 'preview', address: V.public.address, payment_vkh: V.public.payment_vkh }));
  return dir;
}

type Route = (body: any, url: string) => { status?: number; json: unknown };

function run(argv: string[], routes: Record<string, Route>, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const deps: CliDeps = {
    env,
    out: (l) => out.push(l),
    err: (t) => err.push(t),
    nowMs: () => BigInt(V.now_ms),
    sleep: async () => undefined,
    fetchImpl: (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      asked.push({ url, body, headers: init?.headers ?? {} });
      const path = url.split('?')[0];
      const route = routes[path];
      if (!route) throw new Error(`unrouted ${url}`);
      const { status = 200, json } = route(body, url);
      const text = JSON.stringify(json);
      return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
    }) as any,
  };
  return { done: main(argv, deps), out, err, asked };
}

const GENESIS: Record<string, Route> = { [`${KOIOS}/genesis`]: () => ({ json: [{ networkmagic: '2' }] }) };
const COLLATERAL = { ...V.funding.rows[0], tx_hash: 'b0'.repeat(32), tx_index: 0 };

describe('aegis-book refuses before reading anything', () => {
  it('beside an environment name that holds a key', async () => {
    const r = run(['whoami', '--network', 'preview', '--wallet-dir', walletDir()], GENESIS, { BUYER_MNEMONIC: 'x' });
    expect(await r.done).toBe(1);
    expect(r.err.join('')).toContain('BUYER_MNEMONIC');
    expect(r.asked).toEqual([]);
  });

  it('a network AEGIS_NETWORK does not name', async () => {
    const r = run(['whoami', '--network', 'preview', '--wallet-dir', walletDir()], GENESIS, { AEGIS_NETWORK: 'preprod' });
    expect(await r.done).toBe(2);
    expect(JSON.parse(r.out[0]).problems[0].code).toBe('network-not-a-testnet');
    expect(r.asked).toEqual([]);
  });

  it('mainnet', async () => {
    const r = run(['whoami', '--network', 'mainnet', '--wallet-dir', walletDir()], GENESIS);
    expect(await r.done).toBe(2);
    expect(r.asked).toEqual([]);
  });

  it('a Koios that reports another magic', async () => {
    const r = run(['whoami', '--network', 'preview', '--wallet-dir', walletDir()], { [`${KOIOS}/genesis`]: () => ({ json: [{ networkmagic: '1' }] }) });
    expect(await r.done).toBe(2);
    expect(JSON.parse(r.out[0]).problems[0].code).toBe('koios-off-the-network');
    expect(r.asked.map((a) => a.url)).toEqual([`${KOIOS}/genesis`]);
  });
});

describe("a post's ask", () => {
  for (const a of V.asks) {
    it(`of ${a.argv.join(' ')} is the Python tool's`, () => {
      const { args } = parseArgs(['post', '--network', 'preview', '--wallet-dir', 'w', '--instance', 'ada', '--api', API, ...a.argv]);
      if (a.refused) {
        expect(() => askOf(args)).toThrow(BookRefusal);
        try {
          askOf(args);
        } catch (e) {
          expect({ refused: (e as BookRefusal).refusal, detail: (e as BookRefusal).detail }).toEqual({ refused: a.refused, detail: a.detail });
        }
        return;
      }
      const ask = askOf(args);
      const plain = JSON.parse(JSON.stringify(ask, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
      const { termDays, loadBps, minFill, maxFill, ...rest } = plain;
      expect({ ...rest, load_bps: loadBps, term_days: termDays, min_fill: minFill, ...(maxFill !== undefined && { max_fill: maxFill }) })
        .toEqual(a.ok);
    });
  }
});

describe('aegis-book whoami', () => {
  it("prints the wallet's address, key hash and holdings, the token sent to Koios as a bearer", async () => {
    const r = run(['whoami', '--network', 'preview', '--wallet-dir', walletDir()], {
      ...GENESIS, [`${KOIOS}/address_utxos`]: () => ({ json: V.funding.rows }),
    }, { AEGIS_KOIOS_API_TOKEN: 'tok' });
    expect(await r.done).toBe(0);
    const held = V.funding.rows.reduce((s: bigint, x: any) => s + BigInt(x.value), 0n);
    const printed = JSON.parse(r.out[0]);
    expect(printed).toMatchObject({ network: 'preview', address: V.public.address, vkh: V.public.payment_vkh, cut: false });
    expect(BigInt(printed.lovelace)).toBe(held);
    expect(r.asked.every((a) => a.headers.authorization === 'Bearer tok')).toBe(true);
  });
});

describe('aegis-book quote', () => {
  V.quote_lines.forEach((q: any) => {
    it(`${q.instance}${q.request.pin ? ' pinned' : ''}${q.line ? '' : ' unavailable'} asks the Python request and prints the Python line`, async () => {
      const r = run(['quote', '--network', 'preview', '--wallet-dir', walletDir(), '--instance', q.instance, '--api', `${API}/`,
        '--feed', 'ADA/USD', '--strike', '300000', '--coverage', '50', '--term-days', '7', ...(q.request.pin ? ['--pin'] : [])], {
        ...GENESIS,
        [`${KOIOS}/cli_protocol_params`]: () => ({ json: params.response }),
        [`${KOIOS}/address_utxos`]: () => ({ json: [COLLATERAL, { ...COLLATERAL, tx_hash: 'b1'.repeat(32), value: '1000000' }] }),
        [`${API}/api/book/g3/quote`]: () => ({ json: q.answer }),
      });
      const code = await r.done;
      const quoted = r.asked.find((a) => a.url.startsWith(`${API}/api/book/g3/quote`))!;
      if (q.line === undefined) {
        expect(quoted.body.coverage).toBe(q.request.coverage);
        expect(code).toBe(2);
        expect(JSON.parse(r.out[0]).problems[0]).toEqual({ code: q.refused, detail: q.detail });
        return;
      }
      expect(canonicalJson(quoted.body)).toBe(canonicalJson(q.request));
      expect(code).toBe(0);
      expect(r.out).toEqual([q.line]);
    });
  });
});
