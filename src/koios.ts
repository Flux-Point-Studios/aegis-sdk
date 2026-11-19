// The Koios calls the SDK's chain helpers share: row listings, the tip, the protocol
// parameters, and a transaction's evaluation and submission through Koios's Ogmios and
// submit-api endpoints.

import type { Network } from './address';
import { bytesToHex, hexToBytes } from './cbor';
import { ChainError, InputError } from './errors';
import type { MinimalFetch } from './fetch_quote';
import { CHAIN_FACTS } from './networks';
import { protocolParamsFromCli } from './tx';
import type { ProtocolParams } from './tx';

export interface KoiosReadOptions {
  network: Network;
  /** Override fetch (default: globalThis.fetch). */
  fetchImpl?: MinimalFetch;
  /** Koios base URL (default: the network's public Koios). */
  koios?: string;
  /** A Koios API token, sent as a bearer; the public tier answers without one. */
  token?: string;
}

/** A fetch that sends a binary body, as a submission's raw CBOR is sent: globalThis.fetch is one. */
export type BinaryFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface KoiosSubmitOptions extends Omit<KoiosReadOptions, 'fetchImpl'> {
  /** Override fetch (default: globalThis.fetch). */
  fetchImpl?: BinaryFetch;
}

/** The headers a Koios request carries: JSON both ways, and the token as a bearer when one is set. */
export function koiosHeaders(opts: Pick<KoiosReadOptions, 'token'>): Record<string, string> {
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

function fetchOf<F>(given: F | undefined): F {
  const f = given ?? (globalThis as { fetch?: F }).fetch;
  if (!f) throw new InputError('INVALID_INPUT', 'no fetch available: pass opts.fetchImpl');
  return f;
}

function urlOf(opts: Pick<KoiosReadOptions, 'network' | 'koios'>, path: string): string {
  return `${opts.koios ?? CHAIN_FACTS[opts.network].koios}/${path}`;
}

/** Koios's JSON answer to a POST of `body`, or to a GET without one. */
async function koiosAnswer(opts: KoiosReadOptions, path: string, body?: unknown): Promise<unknown> {
  const f = fetchOf(opts.fetchImpl);
  const headers = koiosHeaders(opts);
  const res = await f(
    urlOf(opts, path),
    body === undefined ? { method: 'GET', headers } : { method: 'POST', headers, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new ChainError('UNKNOWN', `Koios ${path} answered HTTP ${res.status}`);
  return res.json();
}

/** A Koios listing's rows: a POST of `body`, or a GET without one. */
export async function koiosRows<T>(opts: KoiosReadOptions, path: string, body?: unknown): Promise<T[]> {
  const rows = await koiosAnswer(opts, path, body);
  if (!Array.isArray(rows)) throw new ChainError('UNKNOWN', `Koios ${path} answered no row listing`);
  return rows as T[];
}

export async function koiosUtxos(opts: KoiosReadOptions, path: string, body: unknown): Promise<KoiosUtxo[]> {
  return koiosRows<KoiosUtxo>(opts, path, body);
}

/** The POSIX milliseconds of the chain's tip block. */
export async function koiosTipMs(opts: KoiosReadOptions): Promise<bigint> {
  const [tip] = await koiosRows<{ block_time?: unknown }>(opts, 'tip');
  const seconds = tip?.block_time;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) {
    throw new ChainError('UNKNOWN', `Koios tip answered block_time ${JSON.stringify(seconds)}, no POSIX second`);
  }
  return BigInt(seconds) * 1000n;
}

/** The protocol parameters Koios's cli_protocol_params answers. */
export async function koiosProtocolParams(opts: KoiosReadOptions): Promise<ProtocolParams> {
  return protocolParamsFromCli((await koiosAnswer(opts, 'cli_protocol_params')) as Record<string, unknown>);
}

/** A redeemer's execution units as an evaluation measures them. */
export interface EvaluatedUnits {
  purpose: string;
  index: number;
  mem: bigint;
  steps: bigint;
}

// Ogmios v5 names two purposes otherwise than v6, which the ledger's CDDL follows.
const OGMIOS_V5_PURPOSE: Readonly<Record<string, string>> = { certificate: 'publish', withdrawal: 'withdraw' };

function count(x: unknown, what: string): bigint {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) {
    throw new ChainError('UNKNOWN', `the evaluation answered ${what} ${JSON.stringify(x)}, no count`);
  }
  return BigInt(x);
}

/**
 * The units each redeemer runs at, from an Ogmios evaluateTransaction answer in either schema:
 * v6's result list, or v5's EvaluationResult map keyed "purpose:index". An error, a fault or any
 * other shape refuses: none of them is a transaction with no redeemers.
 */
export function evaluationUnits(answer: unknown): EvaluatedUnits[] {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new ChainError('UNKNOWN', `the evaluation answered ${Array.isArray(answer) ? 'a list' : typeof answer}, no evaluation`);
  }
  const a = answer as Record<string, any>;
  if ('error' in a || 'fault' in a || String(a.type ?? '').endsWith('fault')) {
    throw new ChainError('SCRIPT_FAILED', `the evaluation failed: ${JSON.stringify(a.error ?? a.fault ?? null)}`);
  }
  const result = a.result;
  if (Array.isArray(result)) {
    return result.map((r: any) => ({
      purpose: String(r?.validator?.purpose),
      index: Number(count(r?.validator?.index, 'an index')),
      mem: count(r?.budget?.memory, 'memory'),
      steps: count(r?.budget?.cpu, 'cpu'),
    }));
  }
  const v5 = typeof result === 'object' && result !== null ? result.EvaluationResult : undefined;
  if (typeof v5 === 'object' && v5 !== null && !Array.isArray(v5)) {
    return Object.entries(v5 as Record<string, any>).map(([tag, budget]) => {
      const [purpose, index] = tag.split(':');
      return {
        purpose: OGMIOS_V5_PURPOSE[purpose] ?? purpose,
        index: Number(count(/^\d+$/.test(index ?? '') ? Number(index) : index, 'an index')),
        mem: count(budget?.memory, 'memory'),
        steps: count(budget?.steps, 'steps'),
      };
    });
  }
  throw new ChainError('UNKNOWN', 'the evaluation answered no result a redeemer reads');
}

/** The units each redeemer of `tx` (hex or bytes) runs at, as Koios's Ogmios evaluates it against the chain. */
export async function koiosEvaluateTransaction(tx: string | Uint8Array, opts: KoiosReadOptions): Promise<EvaluatedUnits[]> {
  const f = fetchOf(opts.fetchImpl);
  const res = await f(urlOf(opts, 'ogmios'), {
    method: 'POST',
    headers: koiosHeaders(opts),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'evaluateTransaction',
      params: { transaction: { cbor: typeof tx === 'string' ? tx : bytesToHex(tx) } },
    }),
  });
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    throw new ChainError('UNKNOWN', `Koios ogmios answered HTTP ${res.status} with no JSON`);
  }
  const units = evaluationUnits(answer);
  if (!res.ok) throw new ChainError('UNKNOWN', `Koios ogmios answered HTTP ${res.status}`);
  return units;
}

/** Submit a signed transaction through Koios's submit-api: the id the node took it under. */
export async function koiosSubmitTransaction(tx: string | Uint8Array, opts: KoiosSubmitOptions): Promise<string> {
  const f = fetchOf(opts.fetchImpl);
  const res = await f(urlOf(opts, 'submittx'), {
    method: 'POST',
    headers: { ...koiosHeaders(opts), 'content-type': 'application/cbor' },
    body: typeof tx === 'string' ? hexToBytes(tx) : tx,
  });
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    answer = undefined;
  }
  if (res.ok && typeof answer === 'string' && /^[0-9a-f]{64}$/.test(answer)) return answer;
  const said = answer === undefined ? 'no JSON' : JSON.stringify(answer).slice(0, 400);
  throw new ChainError('UNKNOWN', `Koios submittx answered HTTP ${res.status} with ${said}, no transaction id`);
}
