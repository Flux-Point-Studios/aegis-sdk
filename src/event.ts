// N2 — Event-class cover: read the on-chain binary event state + compose an
// event underwrite.
//
// An EVENT_SLOT feed (feeds.ts: `kind:'event'`, `riskClass:'Barrier'`) is a
// bespoke oracle provisioned per integration. It publishes a binary
// alive/liquidated value for ONE integrated market's liquidation event, in the
// EXACT SAME Charli3 GenericData wire form the FEAR gauge and the ADA/USD price
// oracle use (api/fear_index.py::build_fear_datum_cbor /
// api/oracle.py::_extract_price_map):
//
//   Tag 121 ([ Tag 123 ([ { 0: value, 1: created_ms, 2: expiry_ms } ]) ])
//
// So there is NO new datum format and NO new risk class. An event policy is a
// Barrier underwrite (PolicyDatum.riskClass = Barrier) bound to the EVENT_SLOT
// feed NFT — the on-chain validator already settles it against that oracle ref
// input exactly as it does a price barrier. `decodeEventDatum` is the read-side
// twin of the feed value, and `isTriggered(value, strike)` is the settlement
// predicate the indexer uses:
//
//   value <= strike  ⇒  the event fired (e.g. the market was liquidated)
//
// For a canonical binary feed the value is 0 (liquidated/triggered) or 1
// (alive), and the policy is struck at 0: value 0 ≤ 0 ⇒ triggered, value 1 > 0
// ⇒ alive. The predicate is intentionally the SAME `value ≤ strike` shape a
// price barrier uses (barrierDBps / spot-vs-strike), so a market that publishes
// a scaled price-like value settles identically.
//
// PRICING: an event policy reuses `quoteBarrier` (quote.ts). A binary
// liquidation event is a barrier struck at the liquidation level — the on-chain
// floor table is asset-independent and applies unchanged — so there is NO
// separate `quoteEvent` primitive to maintain. See `quoteEventCover` below: it
// is a thin, explicitly-documented re-export of the barrier quote, NOT a new
// pricing model.

import { readGenericData } from './generic_data';
import { quoteBarrier, type QuoteVerdict } from './quote';
import { FEEDS } from './feeds';
import type { OracleFeed } from './feeds';
import {
  buildUnderwriteParts,
  type BuildUnderwritePartsParams,
  type UnderwriteParts,
} from './compose';
import { InputError } from './errors';

/** A decoded on-chain event-feed reading (the inner GenericData map, typed). */
export interface EventReading {
  /** The raw on-chain value at map key 0 — the binary alive/liquidated value
   *  (canonically 0 = liquidated/triggered, 1 = alive), or a scaled price-like
   *  value for markets that publish one. */
  value: bigint;
  /** Datum creation time (POSIX ms) — map key 1. */
  createdMs: bigint;
  /** Datum expiry time (POSIX ms) — map key 2; after this the feed is stale. */
  expiryMs: bigint;
}

/**
 * Decode the raw inline-datum bytes of an on-chain EVENT_SLOT feed UTxO into a
 * typed event reading. The wire form is the SAME Charli3 GenericData envelope
 * `decodeFearDatum` reads (Tag 121 [ Tag 123 [ {0:value,1:created,2:expiry} ] ])
 * — this is its event-typed twin (no new datum format). Accepts a `Uint8Array`
 * or a hex string.
 *
 * @throws InputError if the bytes are not a well-formed GenericData datum.
 */
export function decodeEventDatum(raw: Uint8Array | string): EventReading {
  const { value, createdMs, expiryMs } = readGenericData(raw);
  return { value, createdMs, expiryMs };
}

/**
 * The event-settlement predicate: `value <= strike`. True when the insured event
 * has fired (e.g. the integrated market was liquidated). This is the SAME
 * shape a price barrier settles on (spot at/below strike), so a binary feed
 * struck at 0 and a scaled-value feed both settle correctly:
 *
 *   isTriggered(0n, 0n) === true   // liquidated, binary feed struck at 0
 *   isTriggered(1n, 0n) === false  // alive, binary feed struck at 0
 *
 * `strike` defaults to 0n — the canonical binary strike — so the common case is
 * `isTriggered(reading.value)`.
 */
export function isTriggered(value: bigint, strike: bigint = 0n): boolean {
  return value <= strike;
}

/**
 * Pricing for an event policy reuses the barrier quote unchanged — a binary
 * liquidation event is a barrier struck at the liquidation level, and the
 * on-chain floor table is asset-independent. This is a thin, explicit re-export
 * of `quoteBarrier` (NOT a new pricing model) so event call-sites read clearly;
 * see the module header. For the canonical binary feed pass a `strikePriceScaled`
 * / `spotPriceScaled` pair that clears the 15%-below-spot barrier gate.
 */
export function quoteEventCover(params: {
  coverageLovelace: bigint;
  strikePriceScaled: bigint;
  spotPriceScaled: bigint;
  durationDays: number;
  premiumLovelace?: bigint;
}): QuoteVerdict {
  return quoteBarrier(params);
}

/** All EVENT_SLOT feeds, in registry order (the per-integration cover slots). */
export const EVENT_FEEDS: readonly OracleFeed[] = Object.freeze(
  Object.values(FEEDS).filter((f) => f.kind === 'event'),
);

export interface BuildEventUnderwritePartsParams
  extends Omit<BuildUnderwritePartsParams, 'oraclePolicyId' | 'riskClass'> {
  /** The EVENT_SLOT feed symbol (e.g. 'EVENT_SLOT_1') OR a raw 28-byte event
   *  oracle NFT policy id (hex). Defaults to FEEDS.EVENT_SLOT_1. */
  eventFeed?: string;
}

/**
 * Ergonomic wrapper over `buildUnderwriteParts` for the event-cover case: it
 * defaults `riskClass` to 'Barrier' (event cover is a Barrier underwrite — no
 * new class) and resolves the EVENT_SLOT feed NFT for you, so a partner writes
 *
 *   buildEventUnderwriteParts({ bindings, pool, insuredPkh, ...,
 *                               eventFeed: 'EVENT_SLOT_1' })
 *
 * instead of hand-wiring `oraclePolicyId: FEEDS.EVENT_SLOT_1.policyId,
 * riskClass: 'Barrier'`. It adds NO composition logic — it forwards to
 * `buildUnderwriteParts`, which remains the single source of the underwrite
 * parts. `eventFeed` accepts a registry symbol or a raw policy id; an unknown
 * symbol throws rather than silently mis-binding the policy.
 */
export function buildEventUnderwriteParts(
  params: BuildEventUnderwritePartsParams,
): UnderwriteParts {
  const { eventFeed = 'EVENT_SLOT_1', ...rest } = params;

  // Resolve the EVENT_SLOT feed: a registry symbol, else a raw 28-byte NFT hex.
  const feed = FEEDS[eventFeed];
  let oraclePolicyId: string;
  if (feed !== undefined) {
    if (feed.kind !== 'event') {
      throw new InputError(
        'INVALID_INPUT',
        `feed '${eventFeed}' is a '${feed.kind}' feed, not an event feed — use buildUnderwriteParts for non-event cover`,
      );
    }
    oraclePolicyId = feed.policyId;
  } else if (/^[0-9a-fA-F]{56}$/.test(eventFeed)) {
    oraclePolicyId = eventFeed.toLowerCase();
  } else {
    throw new InputError(
      'INVALID_INPUT',
      `eventFeed '${eventFeed}' is neither a known EVENT_SLOT symbol nor a 28-byte (56 hex) oracle NFT policy id`,
    );
  }

  return buildUnderwriteParts({
    ...rest,
    oraclePolicyId,
    riskClass: 'Barrier',
  });
}
