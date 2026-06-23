// T7 — AEGIS/FEAR index decoder + classifier.
//
// PATH TAKEN: full DECODER. The fear datum is concretely defined ON CHAIN and
// decodable — api/fear_index.py::build_fear_datum_cbor publishes it as a
// Charli3-compatible GenericData datum and publish_fear_index lands it in a real
// UTxO (the `fear_feed_utxo` the FearPanel consumes via CIP-31). Its wire form
// is the SAME fixed Plutus structure api/oracle.py::_extract_price_map reads back
// for the ADA/USD price oracle, so the SDK can decode it with zero deps.
//
// The GOLDEN vectors below are byte-for-byte the output of the authoritative
// Python encoder (cbor2.dumps(CBORTag(121,[CBORTag(123,[{0:scaled,1:created,
// 2:expiry}])]))) with pinned timestamps. cbor2 emits DEFINITE arrays (81); the
// decoder also accepts the indefinite (9f…ff) form for feeds round-tripped
// through a different serializer.

import { describe, it, expect } from 'vitest';
import { decodeFearDatum, classifyFear, FEAR_SCALE } from '../fear';
import type { FearBand } from '../fear';

// ── Authoritative golden datums (Python cbor2, pinned times) ────────────────
//   build(fear_scaled, created_ms, expiry_ms):
//     CBORTag(121,[CBORTag(123,[{0: fear_scaled, 1: created_ms, 2: expiry_ms}])])
const GOLDEN = {
  // index 75 (High Fear), created 1.75e12, expiry +300s
  f75: 'd87981d87b81a3001a047868c0011b000001977420dc00021b0000019774256fe0',
  // index 0 (No active market / Extreme Calm), created 1.70e12
  f0: 'd87981d87b81a30000011b0000018bcfe56800021b0000018bcfe9fbe0',
  // index 100 (Extreme Fear), created 1.75e12
  f100: 'd87981d87b81a3001a05f5e100011b000001977420dc00021b0000019774256fe0',
  // index 42 (Moderate), created 1.65e12
  f42: 'd87981d87b81a3001a0280de80011b000001802ba9f400021b000001802bae87e0',
  // index 15 (Extreme Calm — band edge), created 1.75e12
  f15: 'd87981d87b81a3001a00e4e1c0011b000001977420dc00021b0000019774256fe0',
  // index 16 (Low Fear — band edge), created 1.75e12
  f16: 'd87981d87b81a3001a00f42400011b000001977420dc00021b0000019774256fe0',
  // small ints (created=1000, expiry=2000) — exercises the <24 / 2-byte int paths
  f3small: 'd87981d87b81a3001a002dc6c0011903e8021907d0',
} as const;

describe('decodeFearDatum — golden vectors from the authoritative publisher', () => {
  it('decodes the index-75 feed (value, scaled, created, expiry, band)', () => {
    const r = decodeFearDatum(GOLDEN.f75);
    expect(r.fearIndex).toBe(75);
    expect(r.fearScaled).toBe(75_000_000n);
    expect(r.createdMs).toBe(1_750_000_000_000n);
    expect(r.expiryMs).toBe(1_750_000_000_000n + 300_000n);
    expect(r.band).toBe('High Fear');
  });

  it('decodes the index-0 feed (No-active-market / Extreme Calm)', () => {
    const r = decodeFearDatum(GOLDEN.f0);
    expect(r.fearIndex).toBe(0);
    expect(r.fearScaled).toBe(0n);
    expect(r.createdMs).toBe(1_700_000_000_000n);
    expect(r.band).toBe('Extreme Calm');
  });

  it('decodes the index-100 feed (Extreme Fear)', () => {
    const r = decodeFearDatum(GOLDEN.f100);
    expect(r.fearIndex).toBe(100);
    expect(r.fearScaled).toBe(100n * FEAR_SCALE);
    expect(r.band).toBe('Extreme Fear');
  });

  it('decodes the index-42 feed (Moderate)', () => {
    const r = decodeFearDatum(GOLDEN.f42);
    expect(r.fearIndex).toBe(42);
    expect(r.fearScaled).toBe(42_000_000n);
    expect(r.createdMs).toBe(1_650_000_000_000n);
    expect(r.band).toBe('Moderate');
  });

  it('decodes the band-edge feeds (15 → Extreme Calm, 16 → Low Fear)', () => {
    expect(decodeFearDatum(GOLDEN.f15).band).toBe('Extreme Calm');
    expect(decodeFearDatum(GOLDEN.f16).band).toBe('Low Fear');
  });

  it('decodes a feed with small (<24 and 2-byte) timestamp ints', () => {
    const r = decodeFearDatum(GOLDEN.f3small);
    expect(r.fearIndex).toBe(3);
    expect(r.createdMs).toBe(1000n);
    expect(r.expiryMs).toBe(2000n);
    expect(r.band).toBe('Extreme Calm');
  });

  it('accepts both a hex string and a Uint8Array', () => {
    const bytes = new Uint8Array(GOLDEN.f75.length / 2);
    for (let i = 0; i < GOLDEN.f75.length; i += 2) bytes[i / 2] = parseInt(GOLDEN.f75.substring(i, i + 2), 16);
    expect(decodeFearDatum(bytes)).toEqual(decodeFearDatum(GOLDEN.f75));
  });

  it('also decodes the INDEFINITE-array form (re-serialized feed)', () => {
    // Same logical datum as f75 but with indefinite arrays:
    //   d879 9f  d87b 9f  a3 …  ff  ff
    const indefinite =
      'd8799fd87b9fa3001a047868c0011b000001977420dc00021b0000019774256fe0ffff';
    const r = decodeFearDatum(indefinite);
    expect(r.fearIndex).toBe(75);
    expect(r.fearScaled).toBe(75_000_000n);
    expect(r.createdMs).toBe(1_750_000_000_000n);
    expect(r.expiryMs).toBe(1_750_000_300_000n);
  });

  it('rejects malformed bytes (wrong outer constructor)', () => {
    // d87a = Constr 1, not the OracleDatum Constr 0.
    expect(() => decodeFearDatum('d87a81d87b81a3001a047868c0011a00000001021a00000002')).toThrow(/Constr 0/i);
  });

  it('rejects an odd-length hex string', () => {
    expect(() => decodeFearDatum('d8798')).toThrow(/even length/i);
  });

  it('rejects truncated CBOR (unexpected end)', () => {
    // Constr 0 header + array byte present, but no GenericData follows → EOF.
    expect(() => decodeFearDatum('d87981')).toThrow(/Plutus tag|unexpected end/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// classifyFear — band table (matches FearPanel.tsx + fear_index.py thresholds).
//   < 16 Extreme Calm · < 31 Low Fear · < 51 Moderate · < 71 Elevated ·
//   < 86 High Fear · else Extreme Fear
// ───────────────────────────────────────────────────────────────────────────

describe('classifyFear — band table', () => {
  const cases: [number, FearBand][] = [
    [0, 'Extreme Calm'],
    [15, 'Extreme Calm'],
    [16, 'Low Fear'],
    [30, 'Low Fear'],
    [31, 'Moderate'],
    [50, 'Moderate'],
    [51, 'Elevated'],
    [70, 'Elevated'],
    [71, 'High Fear'],
    [85, 'High Fear'],
    [86, 'Extreme Fear'],
    [100, 'Extreme Fear'],
  ];

  it.each(cases)('score %d → %s', (score, band) => {
    expect(classifyFear(score)).toBe(band);
  });

  it('the band edges match fear_index.py (<=15/<=30/<=50/<=70/<=85/else) exactly', () => {
    // fear_index.py uses <=N; classifyFear uses <N+1 — identical on integers.
    for (let s = 0; s <= 100; s++) {
      const py =
        s <= 15 ? 'Extreme Calm'
        : s <= 30 ? 'Low Fear'
        : s <= 50 ? 'Moderate'
        : s <= 70 ? 'Elevated'
        : s <= 85 ? 'High Fear'
        : 'Extreme Fear';
      expect(classifyFear(s)).toBe(py);
    }
  });

  it('rejects out-of-range and non-finite scores', () => {
    expect(() => classifyFear(-1)).toThrow(/\[0, 100\]/);
    expect(() => classifyFear(101)).toThrow(/\[0, 100\]/);
    expect(() => classifyFear(NaN)).toThrow(/finite/);
    expect(() => classifyFear(Infinity)).toThrow(/finite/);
  });
});
