// N2 — Event-class underwrite golden-CBOR regression.
//
// Event cover needs NO new composer and NO new risk class: it is a Barrier
// underwrite (PolicyDatum.riskClass = Barrier) bound to an EVENT_SLOT feed NFT.
// This suite PROVES that buildUnderwriteParts already composes the right parts
// when handed an EVENT_SLOT feed + riskClass:'Barrier', LOCKS the wire bytes
// byte-for-byte (policy datum, pool datum, pool + marker redeemers), and proves
// the thin buildEventUnderwriteParts wrapper emits the IDENTICAL parts.
//
// The underwrite is composed at policy creation — BEFORE the event fires — so a
// "triggered" and an "alive" policy compose to the SAME parts; the distinction
// is a SETTLEMENT state read off the live feed UTxO via decodeEventDatum +
// isTriggered. Both settlement cases are exercised at the end.
//
// Shared pinned inputs + bindings mirror barrier_golden.test.ts so the event
// policy datum is byte-identical to the ADA barrier golden EXCEPT the oracle NFT
// (the EVENT_SLOT_1 feed) — proving the feed wiring is the single moving part.

import { describe, it, expect } from 'vitest';
import { buildUnderwriteParts } from '../compose';
import {
  buildEventUnderwriteParts,
  decodeEventDatum,
  isTriggered,
  quoteEventCover,
  EVENT_FEEDS,
} from '../event';
import { FEEDS, findFeedByPolicyId } from '../feeds';
import { quoteBarrier } from '../quote';
import { decodePoolRedeemer, decodeMarkerRedeemer, hexToBytes, bytesToHex } from '../cbor';

// ── Mainnet V4 bindings (release/mainnet.json) — same frozen manifest the T1 /
//    T3 goldens use, so all three suites share one source of truth. ───────────
const POOL_VALIDATOR_HASH = 'c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f';
const POLICY_VALIDATOR_HASH = '1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7';
const MARKER_HASH = 'd9d24db4e4dabdc1af6a568a4ecd691b81fae891afd70eb6cabc51e7';
const POOL_NFT_POLICY = '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3';
const LP_TOKEN_HASH = '5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b';
const POLICY_ADDR = 'addr1wyt80hz2qzysglhrzdk2004q7dhyn4nsw35gp86004rdldcnuy3ev';
const POOL_ADDR = 'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr';
const TEAM_ADDR = 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3';
const MARKER_NAME_HEX = '41454749535f504f4c494359'; // "AEGIS_POLICY"

function mainnetBindings() {
  return {
    network: 'mainnet' as const,
    policyValidatorHash: POLICY_VALIDATOR_HASH,
    poolValidatorHash: POOL_VALIDATOR_HASH,
    poolAddress: POOL_ADDR,
    poolNftPolicyId: POOL_NFT_POLICY,
    poolNftAssetNameHex: bytesToHex(new TextEncoder().encode('AEGIS_POOL_V4')),
    markerPolicyId: MARKER_HASH,
    teamAddress: TEAM_ADDR,
  };
}

function pool() {
  return {
    utxoRef: { txHash: 'c5f488034e869b1404c505ed797caa49905943641693422b1e19e2a3919ee297', index: 0 },
    lovelace: 100_000_000_000n,
    datum: {
      totalLiquidity: 100_000_000_000n,
      activeCoverage: 1_000_000_000n,
      lpTokenPolicy: hexToBytes(LP_TOKEN_HASH),
      protocolFeeBps: 200n,
      poolNft: hexToBytes(POOL_NFT_POLICY),
      lpSupply: 50_000_000_000n,
    },
  };
}

// Pinned inputs shared with the barrier golden (strike $0.51, spot $1.00 →
// d = 49%, deep past the 15% minimum; 2000 ADA cover, premium just under cover).
// For an event policy the "strike/spot" parameterise the barrier the liquidation
// level maps onto — the feed NFT is the EVENT_SLOT_1 cover slot.
const INSURED = 'ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931';
const POLICY_ID = '739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65';
const STRIKE = 510_000n;
const SPOT = 1_000_000n;
const COVERAGE = 2_000_000_000n;
const PREMIUM = 2_000_000_000n - 1n;
const START = 1_750_000_000_000n;
const EXPIRY = 1_750_000_000_000n + 30n * 86_400_000n;

const EVENT_FEED = FEEDS.EVENT_SLOT_1;

// GOLDEN policy datum — byte-identical to the ADA barrier golden EXCEPT the
// 9th (581c<oracle NFT>) field, which is the EVENT_SLOT_1 feed NFT. Provider
// d87b80 = Constr 2 = AegisSelf; partner d87a80 = None; share 00; risk d87980
// = Constr 0 = Barrier (event cover is a Barrier underwrite — no new class).
const EVENT_POLICY_DATUM_GOLDEN =
  'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65581cae725d4765d908f114552f53422317cbef8c42698fc2b67e454669311a0007c8301a773594001a773593ff1b000001977420dc001b000001980e9fa400581cc2f62874c860e1fc87bae0043066e551153f30fcc5d9944a370e8f8d581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3d87b80d87a8000d87980ff';

// Pool continuation + redeemers are feed-independent (same coverage/premium as
// the barrier golden, so these are the identical bytes).
const POOL_DATUM_GOLDEN =
  'd8799f1b00000017bd4a22001ab2d05e00581c5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b18c8581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb31b0000000ba43b7400ff';
const POOL_REDEEMER_GOLDEN = 'd8799f1a773594001a773593ffff';
const MARKER_REDEEMER_GOLDEN = 'd8799f01ff';

// ── The seam: buildUnderwriteParts with an EVENT_SLOT feed + Barrier. ─────────
function eventPartsViaCompose() {
  return buildUnderwriteParts({
    bindings: mainnetBindings(),
    pool: pool(),
    insuredPkh: INSURED,
    strikePriceScaled: STRIKE,
    spotPriceScaled: SPOT,
    coverageLovelace: COVERAGE,
    premiumLovelace: PREMIUM,
    durationDays: 30,
    oraclePolicyId: EVENT_FEED.policyId,
    oracleProvider: 'AegisSelf',
    riskClass: 'Barrier',
    policyId: POLICY_ID,
    startTimeMs: START,
    expiryTimeMs: EXPIRY,
  });
}

// ── The wrapper: buildEventUnderwriteParts (defaults Barrier + resolves NFT). ─
function eventPartsViaWrapper(eventFeed: string) {
  return buildEventUnderwriteParts({
    bindings: mainnetBindings(),
    pool: pool(),
    insuredPkh: INSURED,
    strikePriceScaled: STRIKE,
    spotPriceScaled: SPOT,
    coverageLovelace: COVERAGE,
    premiumLovelace: PREMIUM,
    durationDays: 30,
    oracleProvider: 'AegisSelf',
    policyId: POLICY_ID,
    startTimeMs: START,
    expiryTimeMs: EXPIRY,
    eventFeed,
  });
}

describe('N2 event-class underwrite golden — buildUnderwriteParts(EVENT_SLOT + Barrier)', () => {
  const parts = eventPartsViaCompose();

  it('the EVENT_SLOT_1 feed is an event feed carrying the Barrier risk class', () => {
    expect(EVENT_FEED.kind).toBe('event');
    expect(EVENT_FEED.riskClass).toBe('Barrier');
    expect(EVENT_FEED.policyId).toBe('c2f62874c860e1fc87bae0043066e551153f30fcc5d9944a370e8f8d');
    expect(findFeedByPolicyId(EVENT_FEED.policyId)).toBe(EVENT_FEED);
    // EVENT_FEEDS lists exactly the four bespoke cover slots.
    expect(EVENT_FEEDS.map((f) => f.symbol)).toEqual([
      'EVENT_SLOT_1',
      'EVENT_SLOT_2',
      'EVENT_SLOT_3',
      'EVENT_SLOT_4',
    ]);
  });

  it('is insurable and composes as a Barrier underwrite (no new risk class)', () => {
    expect(parts.insurable).toBe(true);
    expect(parts.policyDatum.riskClass).toBe('Barrier');
  });

  it('pins the policy to the EVENT_SLOT_1 oracle NFT', () => {
    expect(bytesToHex(parts.policyDatum.oracleNft)).toBe(EVENT_FEED.policyId);
    expect(parts.policyDatum.oracleProvider).toBe('AegisSelf');
  });

  it('GOLDEN: policy output datum CBOR (only the oracle NFT differs from a price barrier)', () => {
    expect(parts.policyOutput.inlineDatumCbor).toBe(EVENT_POLICY_DATUM_GOLDEN);
    expect(parts.policyOutput.inlineDatumCbor.endsWith('d87a8000d87980ff')).toBe(true); // None, 0, Barrier
    // Identical to the ADA barrier golden once the oracle NFT is normalised away.
    const ADA_BARRIER =
      'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65581cae725d4765d908f114552f53422317cbef8c42698fc2b67e454669311a0007c8301a773594001a773593ff1b000001977420dc001b000001980e9fa400581cf0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3d87b80d87a8000d87980ff';
    expect(EVENT_POLICY_DATUM_GOLDEN.replace(EVENT_FEED.policyId, '<NFT>')).toBe(
      ADA_BARRIER.replace(FEEDS.ADA_USD.policyId, '<NFT>'),
    );
  });

  it('places coverage + 1 marker at the policy script address', () => {
    expect(parts.policyOutput.address).toBe(POLICY_ADDR);
    expect(parts.policyOutput.lovelace).toBe(COVERAGE);
    expect(parts.policyOutput.marker).toEqual({ policyId: MARKER_HASH, assetNameHex: MARKER_NAME_HEX, quantity: 1n });
  });

  it('GOLDEN: pool continuation datum + redeemers (feed-independent)', () => {
    expect(parts.poolOutput.address).toBe(POOL_ADDR);
    expect(parts.poolOutput.inlineDatumCbor).toBe(POOL_DATUM_GOLDEN);
    expect(parts.poolRedeemerCbor).toBe(POOL_REDEEMER_GOLDEN);
    expect(decodePoolRedeemer(hexToBytes(parts.poolRedeemerCbor))).toEqual({
      kind: 'Underwrite',
      coverage: COVERAGE,
      premium: PREMIUM,
    });
    expect(parts.mint.redeemerCbor).toBe(MARKER_REDEEMER_GOLDEN);
    expect(decodeMarkerRedeemer(hexToBytes(parts.mint.redeemerCbor))).toEqual({ kind: 'MintMarkers', count: 1 });
  });

  it('an event (Barrier) policy REQUIRES the oracle reference input on chain', () => {
    expect(parts.references.oracleRequired).toBe(true);
  });

  it('validity: start + 30d expiry are exactly the pinned times', () => {
    expect(parts.validity.startTimeMs).toBe(START);
    expect(parts.validity.expiryTimeMs).toBe(EXPIRY);
  });
});

describe('N2 buildEventUnderwriteParts wrapper — IDENTICAL parts, less boilerplate', () => {
  it('the wrapper (symbol) and raw buildUnderwriteParts produce byte-identical parts', () => {
    const viaCompose = eventPartsViaCompose();
    const viaWrapper = eventPartsViaWrapper('EVENT_SLOT_1');
    expect(viaWrapper.policyOutput.inlineDatumCbor).toBe(viaCompose.policyOutput.inlineDatumCbor);
    expect(viaWrapper.policyOutput.inlineDatumCbor).toBe(EVENT_POLICY_DATUM_GOLDEN);
    expect(viaWrapper.poolOutput.inlineDatumCbor).toBe(viaCompose.poolOutput.inlineDatumCbor);
    expect(viaWrapper.poolRedeemerCbor).toBe(viaCompose.poolRedeemerCbor);
    expect(viaWrapper.policyDatum.riskClass).toBe('Barrier');
    expect(bytesToHex(viaWrapper.policyDatum.oracleNft)).toBe(EVENT_FEED.policyId);
    expect(viaWrapper.references.oracleRequired).toBe(true);
  });

  it('defaults to EVENT_SLOT_1 when no eventFeed is given', () => {
    const def = buildEventUnderwriteParts({
      bindings: mainnetBindings(),
      pool: pool(),
      insuredPkh: INSURED,
      strikePriceScaled: STRIKE,
      spotPriceScaled: SPOT,
      coverageLovelace: COVERAGE,
      premiumLovelace: PREMIUM,
      durationDays: 30,
      oracleProvider: 'AegisSelf',
      policyId: POLICY_ID,
      startTimeMs: START,
      expiryTimeMs: EXPIRY,
    });
    expect(bytesToHex(def.policyDatum.oracleNft)).toBe(FEEDS.EVENT_SLOT_1.policyId);
  });

  it('accepts every EVENT_SLOT symbol and binds its NFT', () => {
    for (const feed of EVENT_FEEDS) {
      const p = eventPartsViaWrapper(feed.symbol);
      expect(bytesToHex(p.policyDatum.oracleNft)).toBe(feed.policyId);
      expect(p.policyDatum.riskClass).toBe('Barrier');
    }
  });

  it('accepts a raw 28-byte event oracle NFT policy id', () => {
    const p = eventPartsViaWrapper(FEEDS.EVENT_SLOT_3.policyId);
    expect(bytesToHex(p.policyDatum.oracleNft)).toBe(FEEDS.EVENT_SLOT_3.policyId);
  });

  it('rejects a non-event feed symbol (steers to buildUnderwriteParts)', () => {
    expect(() => eventPartsViaWrapper('ADA_USD')).toThrow(/not an event feed/i);
  });

  it('rejects an unknown / malformed feed reference', () => {
    expect(() => eventPartsViaWrapper('NOT_A_FEED')).toThrow(/neither a known EVENT_SLOT symbol/i);
    expect(() => eventPartsViaWrapper('deadbeef')).toThrow(/neither a known EVENT_SLOT symbol/i);
  });
});

describe('N2 event pricing reuses the barrier quote (no quoteEvent invented)', () => {
  it('quoteEventCover is the barrier quote verbatim', () => {
    const q = { coverageLovelace: COVERAGE, strikePriceScaled: STRIKE, spotPriceScaled: SPOT, durationDays: 30, premiumLovelace: PREMIUM };
    expect(quoteEventCover(q)).toEqual(quoteBarrier(q));
    expect(quoteEventCover(q).insurable).toBe(true);
    expect(quoteEventCover(q).riskClass).toBe('Barrier');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Settlement: the SAME underwrite settles triggered OR alive depending on the
// live feed value, read via decodeEventDatum + isTriggered (value <= strike).
// The golden feed datums are the authoritative Python cbor2 vectors.
// ───────────────────────────────────────────────────────────────────────────

describe('N2 event settlement — triggered vs alive off the live feed value', () => {
  // Binary feed struck at 0: value 0 = liquidated/triggered, value 1 = alive.
  const TRIGGERED_FEED = 'd87981d87b81a30000011b000001977420dc00021b0000019774256fe0'; // value 0
  const ALIVE_FEED = 'd87981d87b81a30001011b000001977420dc00021b0000019774256fe0'; // value 1

  it('a TRIGGERED feed value settles the (alive-composed) policy as fired', () => {
    const parts = eventPartsViaCompose();
    expect(parts.insurable).toBe(true); // composed at creation, before the event
    const reading = decodeEventDatum(TRIGGERED_FEED);
    expect(reading.value).toBe(0n);
    expect(isTriggered(reading.value)).toBe(true);
  });

  it('an ALIVE feed value leaves the policy un-fired', () => {
    const reading = decodeEventDatum(ALIVE_FEED);
    expect(reading.value).toBe(1n);
    expect(isTriggered(reading.value)).toBe(false);
  });

  it('the underwrite parts are IDENTICAL regardless of eventual settlement', () => {
    // The triggered/alive distinction is a settlement read, NOT a different
    // underwrite — the composed parts are byte-identical in both worlds.
    const a = eventPartsViaCompose();
    const b = eventPartsViaCompose();
    expect(a.policyOutput.inlineDatumCbor).toBe(b.policyOutput.inlineDatumCbor);
  });
});
