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
