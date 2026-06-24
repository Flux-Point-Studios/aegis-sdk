# Changelog

## 1.0.4-v4.0 — network-aware preprod feed registry (2026-06-24)

Additive (no breaking changes):

- **`PREPROD_FEEDS` + `feedsFor(network)` + `findFeed(symbol, network)`** — the
  feed registry is now network-aware so preprod consumers no longer hardcode the
  preprod feed NFT. `findFeed('ADA_USD', 'preprod')` returns the live preprod
  publisher feed `d2f08410…` (asset `AEGIS_PRICE_FEED_V1`); `findFeed(...)`
  defaults to mainnet, preserving existing behaviour. Each preprod entry was
  confirmed against its NFT's on-chain asset name and shares all metadata with
  its mainnet twin except `policyId`. `IUSD_USD` has no preprod feed and is
  intentionally absent. `findFeedByPolicyId` now resolves preprod NFTs too
  (mainnet-first). New export: `FeedNetwork` type. (Addresses the
  `aegis-parametric-insurance#62` preprod-feed DX note.)

## 1.0.3-v4.0 — Coverage Vault + Crash Shield + FEAR + preprod V4 constants (2026-06-23)

### preprod V4 pool constants refresh

Preprod/testing only (mainnet constants unchanged):

- **`constants.preprod.ts` resynced to the fresh preprod V4 pool** (manifest
  `release_commit 7097ee1`, supersedes the retired `AEGIS_POOL_12H_V1` /
  `681f71ac`). New pool validator `d5ff8ab1`, policy `9385ef13`, marker
  `9b62c882`, lp `adf71eb2`; NFT policy `2b8d7869` (`AEGIS_POOL_V4`) at
  `addr_test1wr2llz43u…`; new ref UTxOs (pool `07752a5b#0`, marker
  `d9fba00c#0`, policy `f7fa2138#0`, lp `2ff3e3b8#0`). Verified on-chain:
  add-liquidity `15e4d202` + Crash-Shield underwrite `3aed3d7f`
  (`valid_contract: True`, finite validity bounds — resolves
  `aegis-parametric-insurance#62`).

### T3 Crash Shield golden + T7 FEAR index decoder

Additive (no breaking changes):

- **T3 Crash Shield (Barrier)** — no new composer; `buildUnderwriteParts`
  already supports `riskClass:'Barrier'`. Adds `barrier_golden.test.ts` locking
  the Barrier underwrite path byte-for-byte for the three canonical crash-shield
  feeds — **ADA** (`FEEDS.ADA_USD`), **iBTC** (`FEEDS.BTC_USD`), **iETH**
  (`FEEDS.ETH_USD`) — each with `oracleProvider:'AegisSelf'` (these are the
  canonical `AEGIS_PUBLISHER_CANONICAL_NFTS` publisher feeds) and the feed's
  oracle NFT. The three policy datums differ only in the oracle-NFT field; a
  Barrier policy sets `references.oracleRequired = true`.
- **Barrier insurability boundary** table tests on `quoteForPosition`: a strike
  exactly 15% below spot PASSES (`dBps == MIN_STRIKE_DISTANCE_BPS == 1500`),
  14.9% / 14.99% are rejected with `BELOW_MIN_STRIKE_DISTANCE`, and a strike at
  or above spot is rejected with `STRIKE_NOT_BELOW_SPOT`.
- **iSOL / SOL is out of scope**: there is no canonical mainnet SOL feed in
  `FEEDS` / `AEGIS_PUBLISHER_CANONICAL_NFTS` (iSOL exists only as an Indigo CDP
  mock with a placeholder oracle). A test documents the absence; the SDK does
  **not** invent a policy id for it.
- **T7 AEGIS/FEAR index**: `decodeFearDatum(raw)` reads the on-chain fear-feed
  inline datum — the Charli3-compatible GenericData wire form
  (`Tag 121([Tag 123([{0: fear_scaled, 1: created_ms, 2: expiry_ms}])])`,
  authoritative `api/fear_index.py::build_fear_datum_cbor`) — into
  `{ fearIndex, fearScaled, createdMs, expiryMs, band }`. Golden vectors are
  byte-for-byte the Python publisher output; accepts hex or bytes and both the
  definite (publisher) and indefinite (re-serialized) array forms. The 0-100
  compute stays API-side by design.
- **`classifyFear(score)`**: maps a 0-100 score to its band (`<16` Extreme Calm,
  `<31` Low Fear, `<51` Moderate, `<71` Elevated, `<86` High Fear, else Extreme
  Fear) — matches `FearPanel.tsx` and `fear_index.py` exactly.
- New constant `FEAR_SCALE` (1e6). New exports: `decodeFearDatum`,
  `classifyFear`, types `FearReading` / `FearBand`.

### T2 Coverage Vault composers

Additive (no breaking changes):

- **`buildAddLiquidityParts` / `buildRemoveLiquidityParts`**: pool-funded LP
  deposit / withdraw composers a partner splices into their own Lucid tx (the
  T2 Coverage Vault primitive). They mirror `buildUnderwriteParts`' rigor —
  insurability/pool gates run FIRST and throw a named `InputError`/`PoolError`
  rather than emit parts that fail phase-2 on chain. Each returns the pool
  continuation (NFT preserved, `PoolDatum` updated), the provider LP-receipt /
  returned-ADA output, the signed `aLP` mint, and the pool + LP redeemers.
- LP math is validator-authoritative (mirrors
  `contracts/lib/aegis/pool.ak`): first deposit bootstraps 1:1 (`total == 0`),
  subsequent `lpMinted = deposit·lpSupply/total`, withdraw
  `withdrawn = lpBurned·total/lpSupply` — integer-floor, always favouring the
  pool. Exposed as `calculateLpMint` / `calculateWithdrawal`.
- **Solvency invariant** enforced: a `RemoveLiquidity` that would push
  `activeCoverage` above the remaining `totalLiquidity` throws `PoolError`
  (`can_withdraw`).
- `AegisBindings` gains `lpRefUtxo` (LP-token mint-policy reference script);
  `aegisBindings(network)` populates it from the frozen manifest.
- Golden-CBOR regression locking the **T1 iUSD depeg** path
  (`buildUnderwriteParts` with `riskClass:'Depeg'`, `oracleProvider:'Indigo'`,
  `oraclePolicyId = FEEDS.IUSD_USD.policyId`, partner share) — no signature
  change, byte-for-byte vector.

## 1.0.2-v4.0 — canonical policy_id + feed registry (2026-06-17)

Additive (no breaking changes):

- **Canonical `policy_id`**: zero-dep BLAKE2b-224 (`derivePolicyId`,
  golden-tested against `api/policies.py::_generate_policy_id`). The composer now
  derives the policy_id this way by default, so a composed policy is found under
  the same key by the Aegis claim indexer / `/api/policies` with zero partner
  effort. The on-chain validator treats `policy_id` as opaque bytes; an explicit
  override is still honored for exact reproduction.
- **Named feed registry** (`FEEDS`, `MAINNET_FEEDS`, `GENERIC_FEEDS`,
  `feedsByKind`, `findFeedByPolicyId`): look feeds up by symbol
  (`FEEDS.ADA_USD.policyId`) instead of pasting hex, with the right `riskClass`
  per feed. Verified against the publisher's canonical-NFT manifest.
- Docs/examples generalized — the SDK is protocol-agnostic; any loan/CDP/vault
  dApp integrates the same way.

## 1.0.1-v4.0 — developer-experience layer + dual ESM/CJS build (2026-06-17)

Gold-standard partner DX, all additive (no breaking changes):

- **Typed errors**: `AegisError` hierarchy (`InputError` / `InsurabilityError` /
  `PoolError` / `ChainError`) with a stable `code` + actionable `hint` on every
  throw. `buildUnderwriteParts`/`quote` now throw these; `QuoteVerdict` carries
  a machine-readable `reasonCode`.
- **`decodeChainError`**: maps cryptic wallet/node/submit failures
  (`ValidationTagMismatch`/`FailedUnexpectedly`, `PPViewHashesDontMatch`,
  `ValueNotConserved`, collateral, missing-witness, CIP-30 user-declined, …) to
  `{code, title, hint, raw}`.
- **`preflightUnderwrite`**: every gate at once (all blockers, not just the
  first). **`assertPoolMatchesManifest`**: catch a pool redeploy before an
  opaque on-chain reject. **`onTrace`** debug hook on the composer.
- **`formatAda` / `formatUsdScaled` / `formatParts`**, and an optional
  zero-dep **`fetchQuote`** Aegis-API helper.
- **Dual ESM + CJS build** with an `exports` map (`import` → ESM, `require` →
  CJS), `sideEffects:false` for tree-shaking, proper `.js` extensions so the
  ESM build resolves under pure Node ESM as well as bundlers.

## 1.0.0-v4.0 — V4 pool-funded composer (2026-06-17)

Brings the SDK to the live V4 pool-funded protocol and adds the one-click
partner integration surface.

- `PolicyDatum` grows to 14 fields with `risk_class` (`Barrier`/`Depeg`);
  golden-tested byte-for-byte against the live mainnet `dd56e6df` datum.
- `quoteBarrier`/`quoteDepeg`/`quoteForPosition`: verify-only insurability +
  on-chain floor check, mirroring `api/pricing_engine.py` gates exactly.
- `floor_table.ts`: validator-exact integer premium floor (mirror of
  `contracts/lib/aegis/floor_table.ak`).
- `buildUnderwriteParts`: composes a pool-funded Underwrite (policy output,
  pool continuation, fee split, marker mint, treasury donation, validity) for a
  partner to splice into their own loan/CDP transaction.
- `fees.ts` (fee/treasury math), `address.ts` (CIP-19 bech32), `decodePoolDatum`.
- Constants regenerated to the live V4 mainnet pool (`c08edc7f`,
  `AEGIS_POOL_V4`, 10 canonical feeds) and the pool-funded preprod pool.
- `PARTNERS.md` + MeshJS and Lucid integration examples.

## 0.5.0-r17.0 — R17 refresh (2026-05-26)

Refreshes the SDK against the V12.2+R17 testnet-GREEN validator surface.
`PolicyDatum` grows from 10 to 13 positional fields (`oracle_provider`,
`partner_address`, `partner_share_bps`); `MarkerRedeemer` splits into the
4-variant branch-pairing form (`MintMarkers`, `BurnForClaim`,
`BurnForCancel`, `BurnForExpire`); `PoolRedeemer` drops the `policy_script`
field from `ProcessClaim`, `BatchExpireProcess`, and `AcceptCancellation`
(R16/R17 architecture). CBOR encoder switched to indefinite-length Constr
arrays (`d8 79 9f ... ff`) so byte-form survives a CIP-30 wallet round-trip.
Per-network constants are now sourced from `release/<network>.json` via
`scripts/sync_sdk_constants_from_manifest.py`; `constants.preprod.ts` is
auto-generated and `constants.mainnet.ts` is a throwing stub until launch.
The legacy `AEGIS_CONTRACTS` shape and the single-`BurnMarkers` redeemer
are removed; downstream code that consumed them must migrate.

## 0.1.0 — initial release

Initial publish.
