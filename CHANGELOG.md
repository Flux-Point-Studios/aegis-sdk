# Changelog

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
