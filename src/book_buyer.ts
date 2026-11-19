// The buyer's side of a gen-3 sale before the API is asked anything: where the cover pays,
// which feed a pair names, and the request a wallet's cover asks for.

import { addressBytes } from './address';
import { bytesToHex } from './cbor';
import {
  BookRefusal,
  G3_BARRIER,
  G3_DEPEG,
  G3_PREVIEW_FEEDS,
  G3_QUOTE_VALIDITY_MS,
  g3PLegDeposit,
} from './book';
import type { G3AddressView, G3Credential, G3CoverRequest, G3Instance } from './book';
import type { ProtocolParams } from './tx';

const UNIT = 1_000_000n;
const DAY_MS = 86_400_000n;

export const G3_CLASSES: Readonly<Record<string, number>> = { barrier: G3_BARRIER, depeg: G3_DEPEG };

function natural(bytes: Uint8Array, at: { i: number }): number {
  let n = 0;
  for (;;) {
    if (at.i >= bytes.length) throw new BookRefusal('address-unreadable', 'a pointer address ends inside a number');
    const b = bytes[at.i++];
    n = n * 128 + (b & 0x7f);
    if (!(b & 0x80)) return n;
  }
}

/** The credentials a Shelley payment address spells, as the API's JSON names them. */
export function g3AddressView(address: string): G3AddressView {
  const bytes = addressBytes(address);
  const type = bytes[0] >> 4;
  if (type > 7) throw new BookRefusal('address-unreadable', `address type ${type} is no Shelley payment address`);
  const cred = (script: boolean, at: number): G3Credential => {
    const hash = bytesToHex(bytes.slice(at, at + 28));
    return script ? { script: hash } : { key: hash };
  };
  const payment = cred((type & 1) === 1, 1);
  if (type < 4) return { payment, stake: cred((type & 2) === 2, 29) };
  if (type < 6) {
    const at = { i: 29 };
    return { payment, stake: { pointer: [natural(bytes, at), natural(bytes, at), natural(bytes, at)] } };
  }
  return { payment, stake: null };
}

/**
 * Where the cover pays: the wallet's own address when it is staked, which the position pays
 * exactly; null, the insured's key alone, for a wallet with no stake part or a pointer, which
 * the position refuses.
 */
export function g3PayoutOf(view: G3AddressView): G3AddressView | null {
  return view.stake !== null && !('pointer' in view.stake) ? view : null;
}

/** The feed `spec` names: its policy, or the one feed `feeds` names by that pair. */
export function g3FeedNamed(spec: string, feeds: Readonly<Record<string, string>> = G3_PREVIEW_FEEDS): string {
  if (/^[0-9a-f]{56}$/.test(spec)) return spec;
  const found = Object.keys(feeds).filter((policy) => feeds[policy] === spec);
  if (found.length !== 1) throw new BookRefusal('feed-unnamed', `${found.length} feeds of the table vectors are named ${spec}`);
  return found[0];
}

/** The cover a buyer asks for, in whole units of the instance's six-decimal unit. */
export interface G3CoverAsk {
  /** A pair the table vectors name (ADA/USD) or a feed policy. */
  feed: string;
  class: 'barrier' | 'depeg';
  /** The feed's integer price, as its readings carry it. */
  strike: bigint;
  coverage: bigint;
  termDays: bigint;
  /** Pin the one receipt the instance compiles a rate for. */
  pin: boolean;
}

export interface G3CoverWallet {
  /** The insured's payment key hash. */
  insured: string;
  payout: G3AddressView | null;
  funding: string[];
  collateral: string;
}

/**
 * The request a sale of `ask` carries, its premium 0 until quoted and its deposit the least any
 * P-leg of it clears min-UTxO with.
 */
export function g3CoverRequest(
  instance: G3Instance,
  ask: G3CoverAsk,
  wallet: G3CoverWallet,
  params: ProtocolParams,
  feeds: Readonly<Record<string, string>> = G3_PREVIEW_FEEDS,
): G3CoverRequest {
  let pin = null;
  if (ask.pin) {
    if (instance.rates.length !== 1) {
      throw new BookRefusal('no-receipt-to-pin', `the ${instance.name} vector compiles ${instance.rates.length} receipt rates, not one`);
    }
    pin = { policy: instance.rates[0].policy, name: instance.rates[0].name };
  }
  const request: G3CoverRequest = {
    insured: wallet.insured,
    feed: g3FeedNamed(ask.feed, feeds),
    class: G3_CLASSES[ask.class],
    strike: ask.strike,
    coverage: ask.coverage * UNIT,
    term_ms: ask.termDays * DAY_MS,
    premium: 0n,
    deposit: 0n,
    funding: [...wallet.funding].sort(),
    collateral: [wallet.collateral],
    lane: 0,
    ttl_ms: G3_QUOTE_VALIDITY_MS,
    transport_cap: null,
    payout_address: wallet.payout,
    saturn_order: null,
    pin,
  };
  request.deposit = g3PLegDeposit(request, instance, params);
  return request;
}
