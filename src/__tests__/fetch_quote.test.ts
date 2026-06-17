import { describe, it, expect } from 'vitest';
import { fetchQuote } from '../fetch_quote';

function fakeFetch(status: number, payload: unknown) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = async (url: string, init?: any) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { impl, calls };
}

describe('fetchQuote', () => {
  it('POSTs the right body and parses premium_lovelace into a bigint', async () => {
    const { impl, calls } = fakeFetch(200, { premium_lovelace: '80196647', floor_bps: 2714 });
    const q = await fetchQuote(
      {
        riskClass: 'Barrier',
        coverageLovelace: 200_000_000n,
        strikePriceScaled: 600_000n,
        spotPriceScaled: 800_000n,
        durationDays: 30,
        asset: 'ADA',
      },
      { baseUrl: 'https://api.example', fetchImpl: impl },
    );
    expect(q.premiumLovelace).toBe(80_196_647n);
    expect(q.floorBps).toBe(2714);
    expect(calls[0].url).toBe('https://api.example/api/quote');
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({
      risk_class: 'barrier',
      coverage_lovelace: '200000000',
      strike_price: 600000,
      spot_price: 800000,
      days: 30,
      asset: 'ADA',
    });
  });

  it('omits spot_price for depeg', async () => {
    const { impl, calls } = fakeFetch(200, { premium_lovelace: '7864527' });
    await fetchQuote(
      { riskClass: 'Depeg', coverageLovelace: 1_000_000_000n, strikePriceScaled: 950_000n, durationDays: 30, tier: 'established' },
      { baseUrl: 'https://api.example', fetchImpl: impl },
    );
    const body = JSON.parse(calls[0].init.body);
    expect(body.risk_class).toBe('depeg');
    expect('spot_price' in body).toBe(false);
    expect(body.tier).toBe('established');
  });

  it('throws on a non-2xx response', async () => {
    const { impl } = fakeFetch(500, { detail: 'pricing error' });
    await expect(
      fetchQuote({ riskClass: 'Depeg', coverageLovelace: 1n, strikePriceScaled: 950_000n, durationDays: 7 }, { fetchImpl: impl }),
    ).rejects.toThrow(/500/);
  });

  it('throws if the response has no premium', async () => {
    const { impl } = fakeFetch(200, { floor_bps: 18 });
    await expect(
      fetchQuote({ riskClass: 'Depeg', coverageLovelace: 1n, strikePriceScaled: 950_000n, durationDays: 7 }, { fetchImpl: impl }),
    ).rejects.toThrow(/premium/i);
  });
});
