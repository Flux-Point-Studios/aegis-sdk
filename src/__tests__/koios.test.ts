// A Koios read carries the network's token as a bearer when one is set, and none otherwise.

import { describe, expect, it } from 'vitest';
import { koiosUtxos } from '../koios';
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
