// Koios calls: a read carries the network's token as a bearer when one is set and none
// otherwise; an evaluation reads either Ogmios schema and refuses a failure; a submission sends
// the raw CBOR and answers the node's id; the tip is read in milliseconds.

import { describe, expect, it } from 'vitest';
import { evaluationUnits, koiosEvaluateTransaction, koiosSubmitTransaction, koiosTipMs, koiosUtxos } from '../koios';
import type { BinaryFetch } from '../koios';
import type { MinimalFetch } from '../fetch_quote';

function recorder(): { fetchImpl: MinimalFetch; seen: Array<{ url: string; headers: Record<string, string> }> } {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => [] };
  }) as unknown as MinimalFetch;
  return { fetchImpl, seen };
}

describe('a Koios read', () => {
  it('sends the token as a bearer', async () => {
    const { fetchImpl, seen } = recorder();
    await koiosUtxos({ network: 'preview', fetchImpl, token: 'tok' }, 'utxo_info', {});
    expect(seen[0].headers.authorization).toBe('Bearer tok');
    expect(seen[0].url).toBe('https://preview.koios.rest/api/v1/utxo_info');
  });

  it('sends no authorization without one', async () => {
    const { fetchImpl, seen } = recorder();
    await koiosUtxos({ network: 'preview', fetchImpl }, 'utxo_info', {});
    expect(Object.keys(seen[0].headers).sort()).toEqual(['accept', 'content-type']);
  });
});

describe('an evaluation', () => {
  it("reads Ogmios v6's result list", () => {
    expect(evaluationUnits({ result: [{ validator: { purpose: 'spend', index: 2 }, budget: { memory: 10, cpu: 20 } }] }))
      .toEqual([{ purpose: 'spend', index: 2, mem: 10n, steps: 20n }]);
  });

  it("reads Ogmios v5's EvaluationResult map, its purposes in the ledger's names", () => {
    expect(evaluationUnits({ result: { EvaluationResult: { 'withdrawal:0': { memory: 1, steps: 2 }, 'certificate:1': { memory: 3, steps: 4 } } } }))
      .toEqual([{ purpose: 'withdraw', index: 0, mem: 1n, steps: 2n }, { purpose: 'publish', index: 1, mem: 3n, steps: 4n }]);
  });

  it('refuses an error, a fault and any other shape', () => {
    expect(() => evaluationUnits({ error: { code: 3010 } })).toThrow('the evaluation failed: {"code":3010}');
    expect(() => evaluationUnits({ type: 'jsonwsp/fault', fault: 'x' })).toThrow('the evaluation failed: "x"');
    expect(() => evaluationUnits([])).toThrow('the evaluation answered a list, no evaluation');
    expect(() => evaluationUnits({ result: 'ok' })).toThrow('the evaluation answered no result a redeemer reads');
    expect(() => evaluationUnits({ result: [{ validator: { purpose: 'spend', index: -1 }, budget: { memory: 1, cpu: 1 } }] }))
      .toThrow('the evaluation answered an index -1, no count');
  });

  it("posts the transaction to Koios's Ogmios as a JSON-RPC call with the token", async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }) as unknown as MinimalFetch;
    expect(await koiosEvaluateTransaction('84a0', { network: 'preview', fetchImpl, token: 'tok' })).toEqual([]);
    expect(seen[0].url).toBe('https://preview.koios.rest/api/v1/ogmios');
    expect(seen[0].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(seen[0].init.body)).toEqual({ jsonrpc: '2.0', method: 'evaluateTransaction', params: { transaction: { cbor: '84a0' } } });
  });

  it("carries Ogmios's refusal from an HTTP error", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 3117 } }) })) as unknown as MinimalFetch;
    await expect(koiosEvaluateTransaction('84a0', { network: 'preview', fetchImpl })).rejects.toThrow('the evaluation failed: {"code":3117}');
  });
});

describe('a submission', () => {
  it('posts the raw CBOR and answers the id the node took', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const id = 'ab'.repeat(32);
    const fetchImpl: BinaryFetch = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 202, json: async () => id };
    };
    expect(await koiosSubmitTransaction('84a0f5f6', { network: 'preview', fetchImpl, token: 'tok' })).toBe(id);
    expect(seen[0].url).toBe('https://preview.koios.rest/api/v1/submittx');
    expect(seen[0].init.headers['content-type']).toBe('application/cbor');
    expect(seen[0].init.headers.authorization).toBe('Bearer tok');
    expect([...seen[0].init.body]).toEqual([0x84, 0xa0, 0xf5, 0xf6]);
  });

  it("refuses the node's refusal and an answer that is no id", async () => {
    const refusing: BinaryFetch = async () => ({ ok: false, status: 400, json: async () => ({ contents: 'BadInputsUTxO' }) });
    await expect(koiosSubmitTransaction('84a0', { network: 'preview', fetchImpl: refusing }))
      .rejects.toThrow('Koios submittx answered HTTP 400 with {"contents":"BadInputsUTxO"}, no transaction id');
    const silent: BinaryFetch = async () => ({ ok: true, status: 202, json: async () => { throw new SyntaxError('no JSON'); } });
    await expect(koiosSubmitTransaction('84a0', { network: 'preview', fetchImpl: silent }))
      .rejects.toThrow('Koios submittx answered HTTP 202 with no JSON, no transaction id');
  });
});

describe('the tip', () => {
  it("is the tip block's POSIX second in milliseconds, read by a GET", async () => {
    const seen: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      seen.push(init);
      return { ok: true, status: 200, json: async () => [{ block_time: 1_790_000_061 }] };
    }) as unknown as MinimalFetch;
    expect(await koiosTipMs({ network: 'preview', fetchImpl })).toBe(1_790_000_061_000n);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].body).toBeUndefined();
  });

  it('refuses a block_time that is no POSIX second', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => [{ block_time: '61' }] })) as unknown as MinimalFetch;
    await expect(koiosTipMs({ network: 'preview', fetchImpl })).rejects.toThrow('Koios tip answered block_time "61", no POSIX second');
  });
});
