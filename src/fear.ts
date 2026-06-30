// T7 — AEGIS/FEAR index: read + classify Cardano's on-chain fear gauge.
//
// The FEAR index is a 0-100 score (a VIX analogue derived from Aegis insurance
// demand) computed API-side by api/fear_index.py::compute_fear_index, then
// PUBLISHED ON CHAIN as a Charli3-compatible GenericData datum
// (api/fear_index.py::build_fear_datum_cbor, publish_fear_index). Any Cardano
// protocol consumes it via a CIP-31 reference input — exactly like an Aegis /
// Charli3 price feed.
//
// The on-chain datum wire form (authoritative — fear_index.py:190-216) is:
//
//   Tag 121 ([ Tag 123 ([ { 0: fear_scaled, 1: created_ms, 2: expiry_ms } ]) ])
//   └ Constr 0 (OracleDatum)
//             └ Constr 2 (GenericData, "PriceData")
//                       └ Map<Int,Int>  0=value(scaled 1e6) 1=created 2=expiry
//
// This is byte-for-byte the same shape api/oracle.py::_extract_price_map reads
// back from chain for the ADA/USD price oracle, so `decodeFearDatum` is the
// read-side twin: hand it the raw inline-datum bytes from the fear-feed UTxO and
// it returns the typed fear reading. `classifyFear` then maps the 0-100 score to
// the qualitative band the UI + the API agree on.
//
// The raw CBOR walk lives in generic_data.ts (shared with the EVENT_SLOT
// event-state decoder) — this module is the thin FEAR-typed wrapper over it.
//
// WHY a real decoder (not classify-only): the format is concretely on chain and
// decodable. The compute (the 7-signal weighting) stays API-side — re-deriving
// it here would risk divergence from the published datum — but the published
// BYTES are a fixed Plutus structure, so the SDK can read them with zero deps.

import { FEAR_SCALE } from './constants';
import { InputError } from './errors';
import { readGenericData } from './generic_data';

/** "price_scale" the fear value is multiplied by on chain (1e6, == FEAR_SCALE). */
export { FEAR_SCALE };

/** Qualitative fear band — matches FearPanel.tsx + fear_index.py labels. */
export type FearBand =
  | 'Extreme Calm'
  | 'Low Fear'
  | 'Moderate'
  | 'Elevated'
  | 'High Fear'
  | 'Extreme Fear';

/** A decoded on-chain fear reading (the inner GenericData map, typed). */
export interface FearReading {
  /** The 0-100 fear index (== fearScaled / FEAR_SCALE, integer-divided). */
  fearIndex: number;
  /** The raw on-chain value at map key 0 — the index scaled by FEAR_SCALE (1e6). */
  fearScaled: bigint;
  /** Datum creation time (POSIX ms) — map key 1. */
  createdMs: bigint;
  /** Datum expiry time (POSIX ms) — map key 2; after this the feed is stale. */
  expiryMs: bigint;
  /** The qualitative band for `fearIndex`. */
  band: FearBand;
}

/**
 * Decode the raw inline-datum bytes of an on-chain FEAR-feed UTxO into a typed
 * reading. Mirrors the publisher's wire form (fear_index.py::build_fear_datum_cbor)
 * and the price-oracle read path (api/oracle.py::_extract_price_map):
 *
 *   Tag 121 ([ Tag 123 ([ Map{ 0: value, 1: created, 2: expiry } ]) ])
 *
 * Accepts a `Uint8Array` or a hex string. Map key 0 is the FEAR_SCALE-scaled
 * (1e6) index; `fearIndex` is the integer 0-100 score (value / FEAR_SCALE),
 * exactly as the publisher logs it (`fear_scaled // FEAR_SCALE`).
 *
 * @throws InputError if the bytes are not a well-formed fear datum.
 */
export function decodeFearDatum(raw: Uint8Array | string): FearReading {
  const { value, createdMs, expiryMs } = readGenericData(raw);
  const fearIndex = Number(value / FEAR_SCALE);
  return {
    fearIndex,
    fearScaled: value,
    createdMs,
    expiryMs,
    band: classifyFear(fearIndex),
  };
}

/**
 * Map a 0-100 fear score to its qualitative band. The thresholds are the
 * canonical ones shared by api/fear_index.py (`<= 15 / <= 30 / <= 50 / <= 70 /
 * <= 85 / else`) and FearPanel.tsx (`< 16 / < 31 / < 51 / < 71 / < 86 / else`) —
 * the two expressions are identical on integer scores.
 *
 * @throws InputError if `score` is not a finite number in [0, 100].
 */
export function classifyFear(score: number): FearBand {
  if (!Number.isFinite(score)) throw new InputError('INVALID_INPUT', 'fear score must be a finite number');
  if (score < 0 || score > 100) throw new InputError('INVALID_INPUT', `fear score must be in [0, 100], got ${score}`);
  if (score < 16) return 'Extreme Calm';
  if (score < 31) return 'Low Fear';
  if (score < 51) return 'Moderate';
  if (score < 71) return 'Elevated';
  if (score < 86) return 'High Fear';
  return 'Extreme Fear';
}
