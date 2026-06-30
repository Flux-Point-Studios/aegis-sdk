// N2 — event-state decode + settlement predicate.
//
// PATH TAKEN: REUSE, not reinvent. An EVENT_SLOT feed publishes its binary
// alive/liquidated value in the EXACT SAME Charli3 GenericData wire form the
// FEAR gauge (api/fear_index.py::build_fear_datum_cbor) and the ADA/USD price
// oracle (api/oracle.py::_extract_price_map) use:
//
//   Tag 121 ([ Tag 123 ([ { 0: value, 1: created_ms, 2: expiry_ms } ]) ])
//
// `decodeEventDatum` is the event-typed twin of `decodeFearDatum` — both are
// thin wrappers over the shared GenericData reader (src/generic_data.ts), so the
// two read paths cannot drift. The GOLDEN vectors below are byte-for-byte the
// output of the authoritative Python encoder
// (cbor2.dumps(CBORTag(121,[CBORTag(123,[{0:value,1:created,2:expiry}])]))),
// exactly as the fear golden vectors are generated, with pinned timestamps.

import { describe, it, expect } from 'vitest';
import { decodeEventDatum, isTriggered } from '../event';
import { decodeFearDatum } from '../fear';
import { readGenericData } from '../generic_data';

// ── Authoritative golden datums (Python cbor2, pinned times) ────────────────
//   build(value, created_ms, expiry_ms):
//     CBORTag(121,[CBORTag(123,[{0: value, 1: created_ms, 2: expiry_ms}])])
//   created 1.75e12, expiry +300s (the publisher's 5-min validity window).
const GOLDEN = {
  // value 0 = liquidated/triggered (binary feed struck at 0).
  triggered_v0: 'd87981d87b81a30000011b000001977420dc00021b0000019774256fe0',
  // value 1 = alive (binary feed struck at 0).
  alive_v1: 'd87981d87b81a30001011b000001977420dc00021b0000019774256fe0',
  // value 950000 = a scaled price-like value (some markets publish one).
  scaled_v950k: 'd87981d87b81a3001a000e7ef0011b000001977420dc00021b0000019774256fe0',
  // small ints (created=1000, expiry=2000) — exercises the <24 / 2-byte int paths.
  small_v1: 'd87981d87b81a30001011903e8021907d0',
  // INDEFINITE-array form of triggered_v0 (re-serialized feed):
  //   d879 9f  d87b 9f  a3 …  ff  ff
  indefinite_v0: 'd8799fd87b9fa30000011b000001977420dc00021b0000019774256fe0ffff',
} as const;

const CREATED = 1_750_000_000_000n;
const EXPIRY = CREATED + 300_000n;

describe('decodeEventDatum — golden vectors (same GenericData wire form as FEAR)', () => {
  it('decodes the triggered (value 0 = liquidated) feed', () => {
    const r = decodeEventDatum(GOLDEN.triggered_v0);
    expect(r.value).toBe(0n);
    expect(r.createdMs).toBe(CREATED);
    expect(r.expiryMs).toBe(EXPIRY);
  });

  it('decodes the alive (value 1) feed', () => {
    const r = decodeEventDatum(GOLDEN.alive_v1);
    expect(r.value).toBe(1n);
    expect(r.createdMs).toBe(CREATED);
    expect(r.expiryMs).toBe(EXPIRY);
  });

  it('decodes a scaled price-like value', () => {
    const r = decodeEventDatum(GOLDEN.scaled_v950k);
    expect(r.value).toBe(950_000n);
    expect(r.createdMs).toBe(CREATED);
    expect(r.expiryMs).toBe(EXPIRY);
  });

  it('decodes a feed with small (<24 and 2-byte) timestamp ints', () => {
    const r = decodeEventDatum(GOLDEN.small_v1);
    expect(r.value).toBe(1n);
    expect(r.createdMs).toBe(1000n);
    expect(r.expiryMs).toBe(2000n);
  });

  it('accepts both a hex string and a Uint8Array', () => {
    const hex = GOLDEN.triggered_v0;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    expect(decodeEventDatum(bytes)).toEqual(decodeEventDatum(hex));
  });

  it('also decodes the INDEFINITE-array form (re-serialized feed)', () => {
    const r = decodeEventDatum(GOLDEN.indefinite_v0);
    expect(r.value).toBe(0n);
    expect(r.createdMs).toBe(CREATED);
    expect(r.expiryMs).toBe(EXPIRY);
  });

  it('is the event-typed twin of decodeFearDatum over the same bytes', () => {
    // Same wire form → same value/created/expiry, only the typing differs.
    const ev = decodeEventDatum(GOLDEN.scaled_v950k);
    const fear = decodeFearDatum(GOLDEN.scaled_v950k);
    expect(ev.value).toBe(fear.fearScaled);
    expect(ev.createdMs).toBe(fear.createdMs);
    expect(ev.expiryMs).toBe(fear.expiryMs);
  });

  it('shares the GenericData reader with the FEAR decoder (no second walk)', () => {
    const g = readGenericData(GOLDEN.alive_v1);
    expect(g).toEqual({ value: 1n, createdMs: CREATED, expiryMs: EXPIRY });
  });

  it('rejects malformed bytes (wrong outer constructor)', () => {
    // d87a = Constr 1, not the OracleDatum Constr 0.
    expect(() => decodeEventDatum('d87a81d87b81a3001a047868c0011a00000001021a00000002')).toThrow(/Constr 0/i);
  });

  it('rejects an odd-length hex string', () => {
    expect(() => decodeEventDatum('d8798')).toThrow(/even length/i);
  });

  it('rejects truncated CBOR (unexpected end)', () => {
    expect(() => decodeEventDatum('d87981')).toThrow(/Plutus tag|unexpected end/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// isTriggered — settlement predicate `value <= strike` (boundary tests).
//   The SAME shape a price barrier settles on (spot at/below strike).
// ───────────────────────────────────────────────────────────────────────────

describe('isTriggered — value <= strike settlement predicate', () => {
  it('binary feed struck at 0: value 0 ⇒ triggered, value 1 ⇒ alive', () => {
    expect(isTriggered(0n)).toBe(true); // default strike 0n
    expect(isTriggered(1n)).toBe(false);
    expect(isTriggered(0n, 0n)).toBe(true);
    expect(isTriggered(1n, 0n)).toBe(false);
  });

  it('is closed at the boundary (value == strike ⇒ triggered)', () => {
    expect(isTriggered(5n, 5n)).toBe(true); // equal → fires
    expect(isTriggered(4n, 5n)).toBe(true); // below → fires
    expect(isTriggered(6n, 5n)).toBe(false); // above → alive
  });

  it('one unit either side of the strike flips the verdict', () => {
    const strike = 950_000n;
    expect(isTriggered(strike - 1n, strike)).toBe(true);
    expect(isTriggered(strike, strike)).toBe(true);
    expect(isTriggered(strike + 1n, strike)).toBe(false);
  });

  it('settles a decoded event reading end-to-end', () => {
    expect(isTriggered(decodeEventDatum(GOLDEN.triggered_v0).value)).toBe(true);
    expect(isTriggered(decodeEventDatum(GOLDEN.alive_v1).value)).toBe(false);
  });

  it('pins the DEPLOYED Materios geometry: $0.10 triggered / $1.00 alive vs $0.50 strike (1e6 scale)', () => {
    // The whole rail's settlement convention is alive=$1.00=1_000_000,
    // triggered=$0.10=100_000, strike=$0.50=500_000 (pinned in the Python bridge,
    // the C# InsuranceConstants, the on-chain n1_strike, and surf_watch). The SDK
    // read-side predicate must agree against the EXPLICIT 500_000 strike — the
    // default strike of 0n would wrongly read the real triggered value 100_000 as
    // alive (100_000 <= 0 is false), so this must pass the deployed strike.
    const ALIVE = 1_000_000n;
    const TRIGGERED = 100_000n;
    const STRIKE = 500_000n;
    expect(isTriggered(TRIGGERED, STRIKE)).toBe(true); // $0.10 <= $0.50 → fired
    expect(isTriggered(ALIVE, STRIKE)).toBe(false); // $1.00 > $0.50 → alive
    expect(isTriggered(STRIKE, STRIKE)).toBe(true); // boundary closed: == strike fires
  });
});
