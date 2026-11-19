// The Koios reads the SDK's chain helpers share: one POST answered by a row listing.

import type { Network } from './address';
import { ChainError, InputError } from './errors';
import type { MinimalFetch } from './fetch_quote';
import { CHAIN_FACTS } from './networks';

export interface KoiosReadOptions {
  network: Network;
  /** Override fetch (default: globalThis.fetch). */
  fetchImpl?: MinimalFetch;
  /** Koios base URL (default: the network's public Koios). */
  koios?: string;
  /** A Koios API token, sent as a bearer; the public tier answers without one. */
  token?: string;
}

/** The headers a Koios request carries: JSON both ways, and the token as a bearer when one is set. */
export function koiosHeaders(opts: KoiosReadOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return headers;
}

export interface KoiosAsset {
  policy_id: string;
  asset_name: string | null;
  quantity: string;
}

/** An output as Koios' utxo_info, address_utxos and asset_utxos list it with `_extended`. */
export interface KoiosUtxo {
  tx_hash: string;
  tx_index: number;
  address?: string;
  payment_cred: string | null;
  value: string;
  is_spent: boolean;
  datum_hash?: string | null;
  inline_datum: { bytes: string } | null;
  reference_script?: { hash: string; size: number; type: string } | null;
  asset_list: KoiosAsset[] | null;
}

export async function koiosUtxos(opts: KoiosReadOptions, path: string, body: unknown): Promise<KoiosUtxo[]> {
  const f: MinimalFetch | undefined = opts.fetchImpl ?? (globalThis as { fetch?: MinimalFetch }).fetch;
  if (!f) throw new InputError('INVALID_INPUT', 'no fetch available: pass opts.fetchImpl');
  const res = await f(`${opts.koios ?? CHAIN_FACTS[opts.network].koios}/${path}`, {
    method: 'POST',
    headers: koiosHeaders(opts),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ChainError('UNKNOWN', `Koios ${path} answered HTTP ${res.status}`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new ChainError('UNKNOWN', `Koios ${path} answered no row listing`);
  return rows as KoiosUtxo[];
}
