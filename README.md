# @fluxpointstudios/aegis-sdk

[![npm](https://img.shields.io/npm/v/@fluxpointstudios/aegis-sdk)](https://www.npmjs.com/package/@fluxpointstudios/aegis-sdk)
[![CI](https://github.com/Flux-Point-Studios/aegis-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Flux-Point-Studios/aegis-sdk/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](./package.json)

Aegis is parametric insurance for Cardano DeFi: pool-funded cover against
liquidations (loans, CDPs), price-crash barriers, stablecoin depegs, and
protocol events. This SDK lets a partner protocol embed a **one-click "add
insurance"** step into its own loan/CDP setup flow — composing an Aegis
underwrite into the **same transaction** the user already signs.

**Zero runtime dependencies.** The SDK builds policy datums, mirrors the
on-chain premium floor, and produces the exact transaction *parts* you splice
into your own builder (MeshJS, Lucid, cardano-cli). It never touches a wallet
or the chain and never builds or signs a transaction for you.

```bash
npm install @fluxpointstudios/aegis-sdk
```

## Two things you'll use

### 1. Verify a quote (will the chain accept this policy?)

```ts
import { quoteForPosition } from '@fluxpointstudios/aegis-sdk';

const verdict = quoteForPosition({
  riskClass: 'Barrier',
  coverageLovelace: 200_000_000n,   // 200 ADA cover
  strikePriceScaled: 600_000n,      // $0.60 strike (1e6-scaled)
  spotPriceScaled: 800_000n,        // $0.80 spot
  durationDays: 30,
  premiumLovelace: 80_196_647n,     // from the Aegis API /quote
});
// → { insurable, reason, dBps, tDays, floorBps, floorLovelace, premiumClearsFloor }
```

A fail-fast verdict that mirrors the validator's integer floor + insurability
gates (min-strike distance, dead-zone, premium<coverage, peg band), so a
below-floor or dead-zone policy is rejected up front with a named reason
instead of an opaque on-chain failure.

### 2. Compose a pool-funded underwrite into your transaction

```ts
import { aegisBindings, buildUnderwriteParts, decodePoolDatum, hexToBytes } from '@fluxpointstudios/aegis-sdk';

const parts = buildUnderwriteParts({
  bindings: aegisBindings('mainnet'),
  pool: { utxoRef, lovelace, datum: decodePoolDatum(hexToBytes(poolDatumHex)) },
  insuredPkh, strikePriceScaled, spotPriceScaled, coverageLovelace, premiumLovelace,
  durationDays, oraclePolicyId, riskClass: 'Barrier',
});
// parts: policyOutput, poolOutput, teamOutput, partnerOutput, mint,
//        poolRedeemerCbor, treasuryDonationLovelace, references, validity
```

`buildUnderwriteParts` throws a named reason if the policy can't be validly
built (floor, dead-zone, pool can't cover, concentration cap, ratio).

### 3. Coverage Vault: add / remove liquidity (T2)

```ts
import { aegisBindings, buildAddLiquidityParts, buildRemoveLiquidityParts, decodePoolDatum, hexToBytes } from '@fluxpointstudios/aegis-sdk';

const pool = { utxoRef, lovelace, datum: decodePoolDatum(hexToBytes(poolDatumHex)) };

// Deposit ADA → receive aLP. lpMinted is validator-exact (favours the pool).
const add = buildAddLiquidityParts({ bindings: aegisBindings('mainnet'), pool, providerPkh, depositLovelace });
// add: poolOutput, providerOutput (aLP receipt), mint (+aLP MintLP),
//      poolRedeemerCbor (AddLiquidity), lpRedeemerCbor (MintLP), references, lpMinted

// Burn aLP → receive proportional ADA. Throws PoolError if it would impair coverage.
const rem = buildRemoveLiquidityParts({ bindings: aegisBindings('mainnet'), pool, providerPkh, lpTokensToBurn });
// rem: poolOutput, providerOutput (returned ADA), mint (−aLP BurnLP),
//      poolRedeemerCbor (RemoveLiquidity), lpRedeemerCbor (BurnLP), references, withdrawnLovelace
```

Like `buildUnderwriteParts`, both gate first and throw a named
`InputError`/`PoolError` (non-positive amount, dust-floors-to-zero,
burn exceeds supply, **solvency**: a withdrawal that pushes `activeCoverage`
above the remaining `totalLiquidity`) rather than emit parts that fail on
chain. `calculateLpMint` / `calculateWithdrawal` expose the raw validator math.

### 4. Read the on-chain AEGIS/FEAR index (T7)

```ts
import { decodeFearDatum, classifyFear } from '@fluxpointstudios/aegis-sdk';

// `rawDatumHex` is the inline datum of the fear-feed UTxO (read via CIP-31).
const fear = decodeFearDatum(rawDatumHex);
// → { fearIndex: 75, fearScaled: 75_000_000n, createdMs, expiryMs, band: 'High Fear' }

classifyFear(42); // → 'Moderate'
```

The AEGIS/FEAR index is a 0-100 fear gauge (a VIX analogue) computed from Aegis
insurance demand and **published on chain** as a Charli3-compatible GenericData
datum, consumable by any Cardano protocol via a CIP-31 reference input. The
0-100 compute stays API-side (`/api/fear-index`); `decodeFearDatum` reads the
published datum bytes back (zero deps), and `classifyFear` maps the score to its
band (`<16` Extreme Calm · `<31` Low Fear · `<51` Moderate · `<71` Elevated ·
`<86` High Fear · else Extreme Fear).

### 5. Event-class cover: underwrite a binary liquidation event (N2)

```ts
import {
  buildEventUnderwriteParts,
  decodeEventDatum,
  isTriggered,
} from '@fluxpointstudios/aegis-sdk';

// Compose: event cover is a Barrier underwrite bound to an EVENT_SLOT feed —
// no new risk class. The wrapper defaults riskClass:'Barrier' and resolves the
// feed NFT for you (pass a symbol or a raw 28-byte oracle NFT policy id).
const parts = buildEventUnderwriteParts({
  bindings, pool, insuredPkh,
  strikePriceScaled, spotPriceScaled, coverageLovelace, premiumLovelace,
  durationDays: 30,
  eventFeed: 'EVENT_SLOT_1', // defaults to EVENT_SLOT_1
});

// Settle: read the live EVENT_SLOT feed datum and test value <= strike.
const ev = decodeEventDatum(rawEventDatumHex); // { value, createdMs, expiryMs }
isTriggered(ev.value);      // value 0 (liquidated) ≤ 0 → true
isTriggered(ev.value, 0n);  // explicit strike; binary feeds are struck at 0
```

An EVENT_SLOT feed is a bespoke oracle provisioned per integration that publishes
a **binary alive/liquidated value** for one market's liquidation event — in the
**same Charli3 GenericData wire form** the FEAR gauge and the price oracle use
(`Tag 121([Tag 123([{0: value, 1: created, 2: expiry}])])`), so there is **no new
datum format and no new risk class**. An event policy is a `Barrier` underwrite
(`references.oracleRequired = true`) bound to the EVENT_SLOT NFT; the validator
settles it against that oracle ref input exactly as it does a price barrier.
`decodeEventDatum` is the event-typed twin of `decodeFearDatum` (both share one
GenericData reader), and `isTriggered(value, strike)` is the `value ≤ strike`
settlement predicate. Event **pricing reuses the barrier quote** — `quoteEventCover`
is a documented re-export of `quoteBarrier`, not a separate model.

**See [`PARTNERS.md`](./PARTNERS.md) for the full integration guide** and
[`examples/`](./examples/) for MeshJS and Lucid walkthroughs.

## Also exported

- `encodePolicyDatum` / `encodePoolDatum` / `decodePoolDatum` and the redeemer
  encoders/decoders — indefinite-length Constr CBOR that survives a CIP-30
  wallet round-trip byte-for-byte.
- `barrierFloorBps` / `depegFloorBps` / `meetsBarrierFloor` — the validator-exact
  premium floor table (integer, no floats).
- `calculateFeeTotal` / `calculateProtocolFeeSplit` / `calculateTreasuryCut` —
  the fee/treasury math the validator enforces to the lovelace.
- `scriptEnterpriseAddress` / `keyAddress` — CIP-19 bech32 address encoders.
- `hybridStakeAddress` / `scriptStakeAddress` — the zero-premium-cover
  enrollment shapes: key-payment + script-stake base address (principal stays
  spendable by the payment key; the per-enrollee premium_stake script governs
  delegation and rewards) and the script reward account for account-state
  reads. Take the script hash from the enroll build response's
  `summary.premium_stake_hash`.
- `decodeFearDatum` / `classifyFear` — read the on-chain AEGIS/FEAR index datum
  (T7) and map a 0-100 score to its qualitative band.
- `buildEventUnderwriteParts` / `decodeEventDatum` / `isTriggered` /
  `quoteEventCover` (N2) — compose + settle event-class cover: a Barrier
  underwrite bound to an EVENT_SLOT feed, the binary event-state decoder, the
  `value ≤ strike` settlement predicate, and the barrier-quote re-export.
- `readGenericData` — the shared Charli3 GenericData reader that backs both
  `decodeFearDatum` and `decodeEventDatum` (zero deps).
- Per-network frozen-manifest constants (`AEGIS_POOL_ADDRESS`, the canonical
  oracle feed NFTs, ref-script UTxOs, …) for `mainnet` and `preprod`.

## Conventions

- Amounts are lovelace `bigint`; USD prices are 1e6-scaled `bigint`
  (`$0.60` → `600_000n`).
- The premium itself comes from the Aegis API (the exact actuarial GBM/hazard
  price). The SDK is verify-only on pricing by design — re-deriving it in
  floating point risks diverging below the integer on-chain floor.

## License

MIT
