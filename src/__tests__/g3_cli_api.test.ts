// The API as the gen-3 CLIs read it, against the Python client (fixtures/g3_cli_vectors.json):
// each answer it parses or the refusal it raises, and the quote line the buyer CLI prints.

import { describe, expect, it } from 'vitest';
import { BookRefusal, G3_INSTANCES, bookPost, quoteG3Cover } from '../book';
import { g3QuoteLine } from '../book_buyer';
import type { MinimalFetch } from '../fetch_quote';
import vectors from './fixtures/g3_cli_vectors.json';

const V = vectors as any;
const preview = G3_INSTANCES.preview!;

function served(status: number, body: unknown, seen: string[] = []): MinimalFetch {
  return (async (url: string) => {
    seen.push(url);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  }) as unknown as MinimalFetch;
}

async function answered(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await call() };
  } catch (e) {
    if (!(e instanceof BookRefusal)) throw e;
    return { refused: e.refusal, detail: e.detail };
  }
}

describe('an API answer', () => {
  V.answers.forEach((a: any) => {
    it(`at HTTP ${a.status} reads as the Python client reads it`, async () => {
      const seen: string[] = [];
      const got = await answered(() => bookPost({ baseUrl: 'http://api.test/', fetchImpl: served(a.status, a.body, seen) },
        preview.ada, '/api/book/g3/quote', {}));
      expect(got).toEqual(a.ok !== undefined ? { ok: a.ok } : { refused: a.refused, detail: a.detail });
      expect(seen).toEqual([`http://api.test/api/book/g3/quote?network=${a.params.network}&unit=${a.params.unit}`]);
    });
  });
});

describe('the quote line', () => {
  V.quote_lines.forEach((q: any) => {
    it(`${q.instance} ${q.line ? 'prints as Python prints it' : `is refused ${q.refused}`}`, async () => {
      const api = { baseUrl: 'http://api.test', fetchImpl: served(200, q.answer) };
      const got = await answered(() => quoteG3Cover(api, preview[q.instance], q.request));
      if (q.line === undefined) {
        expect(got).toEqual({ refused: q.refused, detail: q.detail });
        return;
      }
      expect(g3QuoteLine((got as any).ok, q.request)).toBe(q.line);
    });
  });
});
