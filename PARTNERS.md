# Integrating Aegis insurance — partner guide

Add one-click liquidation/depeg insurance to your protocol's loan or CDP setup
flow. The Aegis pool funds the coverage; your user pays only a premium (plus a
tiny treasury donation + tx fees). Because Cardano is eUTxO, you can open the
loan/CDP **and** underwrite the policy in the **same transaction** — one
signature, one fee, atomic (if either leg fails validation, the whole tx is
rejected).

`@fluxpointstudios/aegis-sdk` has **zero runtime dependencies**. It does not build,
balance, sign, or submit transactions and never touches a wallet or the chain.
It produces the exact *parts* (outputs, mint, redeemer, datum, treasury
donation, validity window) that you splice into the transaction **your own**
builder (MeshJS, Lucid, cardano-cli) is already assembling.

## Install

```bash
npm install @fluxpointstudios/aegis-sdk
```

## The four-step flow

```ts
import { aegisBindings, quoteForPosition, buildUnderwriteParts, decodePoolDatum, hexToBytes } from '@fluxpointstudios/aegis-sdk';

// 1. Premium — fetch from the Aegis API (the exact actuarial price; the SDK
//    deliberately does NOT re-derive it, to avoid float divergence below the
//    integer on-chain floor).
const premiumLovelace = BigInt((await fetchAegisQuote(...)).premium_lovelace);

// 2. Verify — fail-fast: will the chain accept this exact policy? Surfaces the
//    floor / dead-zone / premium<coverage / ratio reasons up front instead of
//    an opaque phase-2 reject.
const verdict = quoteForPosition({ riskClass: 'Barrier', coverageLovelace, strikePriceScaled, spotPriceScaled, durationDays, premiumLovelace });
if (!verdict.insurable) showReason(verdict.reason);

// 3. Read the live pool UTxO (singleton, pinned by the pool NFT) and decode it.
const bindings = aegisBindings('mainnet');
const poolDatum = decodePoolDatum(hexToBytes(poolUtxo.datumHex));

// 4. Compose the Underwrite parts and splice them into your tx.
const parts = buildUnderwriteParts({ bindings, pool: { utxoRef, lovelace, datum: poolDatum },
  insuredPkh, strikePriceScaled, spotPriceScaled, coverageLovelace, premiumLovelace,
  durationDays, oraclePolicyId, riskClass: 'Barrier' });
```

`buildUnderwriteParts` **throws** with a named reason (floor, dead-zone, can't
cover, concentration cap, ratio) if the policy could not be validly built — so
you never emit a tx that would silently fail on chain.

## What `UnderwriteParts` gives you

| Field | Splice as | Notes |
|-------|-----------|-------|
| `policyOutput` | output at `address` with `lovelace` + `marker` token, inline `inlineDatumCbor` | the pool funds `lovelace` = coverage |
| `poolOutput` | continuation output at the pool address with `lovelace` + `poolNft`, inline `inlineDatumCbor` | preserve the pool NFT |
| `teamOutput` | output to `address` of `lovelace` | always present (fee floor) |
| `partnerOutput` | output to `address` of `lovelace`, or `null` | only if you set `partner` and the cut clears min-utxo |
| `mint` | mint `+1` `{policyId, assetNameHex}` with `redeemerCbor` | the policy marker |
| `poolRedeemerCbor` | spend redeemer on the pool input | `Underwrite{coverage, premium}` |
| `poolInput` | the pool UTxO you spend | |
| `references` | `readFrom` the `poolValidator` + `marker` ref scripts; attach the live oracle UTxO if `oracleRequired` | Barrier policies need the oracle ref input |
| `treasuryDonationLovelace` | the Conway `treasury_donation` body field | the tx is rejected if short by even 1 lovelace |
| `validity` | `validFrom`/`validTo` bounds around `startTimeMs` | start is `now − 120s` by default |

## Risk classes

- **Barrier** (loan/CDP liquidation, price events): price-touch cover. Requires a
  `spotPriceScaled` for the floor pre-flight and an oracle reference input on
  chain. Strike must sit ≥ 15% below spot.
- **Depeg** (stablecoins): Poisson-hazard cover. No spot needed; the strike must
  sit in the [50%, 95%]-of-peg band.

## Worked examples

- [`examples/loan-protect.ts`](./examples/loan-protect.ts) — MeshJS, a
  loan/borrow liquidation barrier.
- [`examples/cdp-protect.ts`](./examples/cdp-protect.ts) — Lucid, an
  ADA-collateralized CDP / vault barrier.

The older `examples/*-integration.ts` / `one-tx-cdp-insurance.ts` files
demonstrate the legacy R17 premium-funded model and are superseded by the two
above for the live V4 pool-funded protocol.

## Oracle feeds (mainnet)

Pass the canonical feed NFT policy id for the priced asset as `oraclePolicyId`.
Look it up by symbol from the `FEEDS` registry instead of pasting hex:

```ts
import { FEEDS, GENERIC_FEEDS } from '@fluxpointstudios/aegis-sdk';

FEEDS.ADA_USD.policyId   // ADA/USD spot   → riskClass 'Barrier'
FEEDS.USDC_USD.policyId  // USDC depeg     → riskClass 'Depeg'
FEEDS.USDT_USD.policyId  // USDT depeg     → riskClass 'Depeg'
FEEDS.IUSD_USD.policyId  // iUSD/USD relay → riskClass 'Barrier'
GENERIC_FEEDS            // every non-bespoke feed (spot + depeg + relay)
```

`spot` / `depeg` / `relay` feeds are generic — any dApp pricing that underlying
uses them directly. `event` feeds (`EVENT_SLOT_1…4`) are bespoke: each emits a
binary alive/liquidated value for one integrated market and is provisioned per
integration — ask us for a feed NFT if your product needs an event trigger.

The full live set is exported as `AEGIS_PUBLISHER_CANONICAL_NFTS`.

## Notes

- All amounts are lovelace `bigint`; prices are 1e6-scaled USD `bigint`
  (e.g. `$0.60` → `600_000n`).
- Networks: `aegisBindings('mainnet')` / `aegisBindings('preprod')`.
- The policy is claimable permissionlessly once its barrier/depeg condition is
  met; coverage pays out from the pool to the insured.
