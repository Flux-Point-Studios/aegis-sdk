// fetchQuote — a thin, optional helper to fetch the authoritative actuarial
// premium from the Aegis API. The SDK is verify-only on pricing (it never
// re-derives the premium), so the typical flow is: fetchQuote → quoteForPosition
// (verify) → buildUnderwriteParts. Uses the runtime's global fetch by default;
// inject `fetchImpl` for Node < 18 or tests. Zero-dep — no DOM lib types.

export interface FetchQuoteParams {
  riskClass: 'Barrier' | 'Depeg';
  coverageLovelace: bigint;
  /** 1e6-scaled USD strike. */
  strikePriceScaled: bigint;
  /** 1e6-scaled USD spot (Barrier only). */
  spotPriceScaled?: bigint;
  durationDays: number;
  /** Barrier underlying key (e.g. 'ADA', 'ALT_LIQUID'). */
  asset?: string;
  /** Depeg coin tier (e.g. 'established'). */
  tier?: string;
}

/** Minimal fetch shape — avoids depending on DOM lib types. */
export type MinimalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface FetchQuoteOptions {
  /** Aegis API base URL. Default: https://api.aegis.fluxpointstudios.com */
  baseUrl?: string;
  /** Override fetch (default: globalThis.fetch). */
  fetchImpl?: MinimalFetch;
  signal?: unknown;
}

export interface FetchedQuote {
  premiumLovelace: bigint;
  /** The on-chain floor (bps of coverage), if the API returns it. */
  floorBps?: number;
  /** The raw API response, for any extra fields. */
  raw: unknown;
}

const DEFAULT_BASE_URL = 'https://api.aegis.fluxpointstudios.com';

export async function fetchQuote(
  params: FetchQuoteParams,
  opts: FetchQuoteOptions = {},
): Promise<FetchedQuote> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const f: MinimalFetch | undefined = opts.fetchImpl ?? (globalThis as any).fetch;
  if (!f) {
    throw new Error('fetchQuote: no fetch available — pass opts.fetchImpl (Node < 18) or use a runtime with global fetch.');
  }

  const body: Record<string, unknown> = {
    risk_class: params.riskClass.toLowerCase(),
    coverage_lovelace: params.coverageLovelace.toString(),
    strike_price: Number(params.strikePriceScaled),
    days: params.durationDays,
  };
  if (params.spotPriceScaled !== undefined) body.spot_price = Number(params.spotPriceScaled);
  if (params.asset) body.asset = params.asset;
  if (params.tier) body.tier = params.tier;

  const res = await f(`${baseUrl}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`Aegis /api/quote failed: HTTP ${res.status} ${detail}`.trim());
  }

  const json = await res.json();
  const premium = json?.premium_lovelace ?? json?.premiumLovelace;
  if (premium === undefined || premium === null) {
    throw new Error('Aegis /api/quote returned no premium_lovelace');
  }
  return {
    premiumLovelace: BigInt(premium),
    floorBps: json?.floor_bps ?? json?.floorBps,
    raw: json,
  };
}
