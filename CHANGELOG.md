# Changelog

## Unreleased — gen-3 wallet CLI

Additive:

- **The USDCx instance on preview** — `G3_PREVIEW_USDCX` beside `G3_PREVIEW_ADA`,
  both in `G3_INSTANCES`, with `G3_PREVIEW_FEEDS` naming each preview feed by its
  pair. An instance now carries its name, unit policy and name, the lovelace each
  leg carries beside the unit, its Liqwid observer, the ADA/USD feed its unit is
  priced on, the receipt rates it compiles and its genesis table rows with their
  reference sheets.
- **Cover requests** — `g3CoverRequest(instance, ask, wallet, params)` writes the
  request the API's routes read, its deposit sized by `g3PLegDeposit`.
  `g3PayoutOf(view)` commits a staked wallet's own address as the payout, so a
  claim or a cancel's refund lands where the wallet shows it; a wallet with no
  stake part or a pointer pays the insured key alone. `g3AddressView` reads a
  bech32 address as the routes name it, and `g3FeedNamed` finds a feed by pair.
- **`koiosHeaders`** — a Koios read sends `KoiosReadOptions.token` as a bearer.
- **The buyer's cancel** — `prepareG3BuyerCancel({ instance, position, wallet,
  koios, tipMs?, params? })` reads the position from the sale that wrote it and
  the publisher's standing reading of its feed from Koios, builds the unsigned
  BuyerCancel (the refund less the 10% cancellation fee to the payee in the
  instance's unit, each leg home less its own refund, the markers burned),
  judges it with the pre-sign mirror and has Koios's Ogmios evaluate it. It
  refuses with the Python CLI's codes and details, and its bytes and printed
  summary are the CLI's byte for byte (`g3_cancel_vectors.json`). Its parts are
  exported: `readG3Position`, `readG3Reading` / `g3StandingReading`,
  `buildG3BuyerCancel`, `g3CancelSummary`, `g3CancelRefund` and
  `g3BuyerCancelProblems`, the mirror of `settlement_problems` for a cancel.
- **Koios calls** — `koiosTipMs`, `koiosProtocolParams`, `koiosRows`,
  `koiosEvaluateTransaction` (Ogmios v6 or v5, read by `evaluationUnits`) and
  `koiosSubmitTransaction`, which sends raw CBOR through a `BinaryFetch`.

Changed:

- `G3CoverRequest.pin` takes a `G3ReceiptPin` and `payout_address` a
  `G3AddressView`, each or null; `g3PolicyDatum` writes them into the payout
  address and the extension, and `verifyG3Sale` holds the P-leg's payout to the
  request's.
- `G3Instance` gains required fields (above); a caller building its own instance
  must supply them.

## Unreleased — N2 event-class cover

Additive (no breaking changes):

- **Chain facts per network** — `CHAIN_FACTS` records each network's magic
  (preview 2), address network id, Shelley slot origin (preview 1666656000 s)
  and public Koios; `slotToPosixMs` / `posixMsToSlot` convert a slot and the
  POSIX milliseconds a script reads its validity bound as.
- **`bech32Address` / `decodeBech32Address`** — the CIP-19 base and enterprise
  address codec for any key or script payment and stake credential.
- **`decodePlutusData`** — reads any Plutus Data another protocol writes:
  bignums, chunked bytestrings, maps, and constructors under every tag form.
- **FluidTokens V4 loans** — `readFluidLoans(borrowerAddress, { network })` finds
  a borrower's live loans at the pinned suite's loan script under their stake
  credential; `decodeFluidLoanDatum` reads the 17-field LoanDatum (debt,
  collateral, liquidation line, repayment mode, lendDate); `remainingDebt`
  mirrors the protocol's perpetual-loan debt and reproduces the remainingDebt
  preview's liquidations asserted on chain.
- **RH1 cover of a loan** — `rh1CoverParams(loan, { startMs, termDays })` sizes
  cover at the loan's debt, for a 1-180 day term, triggered by its liquidation,
  and reports how far the loan stands from its line; `coverFluidLoan(loanRef,
  opts)` reads the loan by its UTxO and returns the typed `FluidCoverRequest` a
  gen-3 Book sale on the RH1 row is built from. A loan that can be claimed for
  lateness, owes a token other than ADA, or has no liquidation line is refused
  with `LOAN_NOT_COVERABLE`.
- **FluidTokens V4 pools and borrows** — the Plutus Data of an open-pool and a
  borrow from it, as the protocol's validators rebuild them: `fluidPoolDatum`
  (a permissionless pool lending ADA against ADA at `FluidPoolTerms`;
  `FLUID_PREVIEW_ADA_TERMS` are FluidTokens' own preview terms),
  `fluidPoolNftName`, `fluidLoanDatum` (the LoanDatum a borrow from that pool
  locks), `fluidLoanId`, the pool mint, pool withdraw, loan mint, bond and
  borrow-action redeemers, `fluidRedeemerPosition` (where the ledger orders the
  redeemer the loan mint points at) and `fluidDraftUnits`.
  `fluidBorrowGuards(pool, { principal, collateral, validFromMs, validToMs })`
  makes a borrow's whole-transaction checks that size no output: a validity
  range of at most `FLUID_MAX_VALIDITY_MS`, a positive principal, a pool
  lending ADA against ADA at a static ratio, and collateral at the pool's
  minCollateral ratio; it returns the collateral the pool asks. Choosing
  inputs, balancing and signing stay the caller's, as does leaving the pool
  at its min-UTxO, which sizes an output this SDK does not encode.
- **Conway transactions** — `decodeTransaction` reads a signed or unsigned
  transaction (inputs, outputs with inline datums and script references,
  withdrawals, mint, validity, collateral, required signers, reference inputs,
  the key-22 treasury donation, redeemers and vkey witnesses) and names it by
  the hash of its body's own bytes; `spliceVkeyWitnesses` adds a CIP-30
  `signTx` answer without touching the body; `encodeTransaction` writes a
  `TxDraft` back; `scriptDataHash`, `minFee` (Conway's size, execution and
  tiered reference-script fees), `minUtxo` and `requiredCollateral` price it;
  `protocolParamsFromCli` reads `cardano-cli` protocol-parameter JSON with
  decimal prices as exact fractions. The first preview gen-3 Book sale
  (cf447ae7) decodes, re-encodes byte for byte and prices at the fee and
  min-UTxO it landed with.
- **Borrow and buy cover in one transaction** —
  `composeFluidBorrowWithCover` writes one unsigned transaction that borrows
  from a FluidTokens V4 pool and underwrites gen-3 Book cover in it, balanced
  on one change output at the ledger's fee and collateral. The borrow's four
  outputs stand first, where its scripts look for them, and every index the
  Underwrite names follows them; the loan and both bonds are named by the
  hash of the pool input; the Treasury's cut goes to the accrual script,
  since the position validator counts the body's donation only when its pair
  is the whole mint. Against recorded preview state, every FluidTokens
  borrow script and the gen-3 Underwrite evaluate within budget under
  `aiken tx simulate`.
- **`examples/fluid-borrow-with-cover.ts`** — the composer end to end on
  preview, dry run by default, with `examples/wallet-dir-signer.ts`, a
  CIP-30-shaped signer over a wallet directory whose CIP-1852 keys and
  `signData` answers match pycardano's.
- **Gen-3 Book cover from the buyer's wallet** — `quoteG3Cover`,
  `prepareG3Cover` and `submitG3Sale` call the Aegis API's
  `/api/book/g3/{quote,prepare,submit}` routes, keeping each refusal's route
  code on a `BookRefusal`; `g3RequestHash` and `g3ReservationPayload` write
  the request and the reservation text the insured's wallet signs with CIP-30
  `signData`, byte for byte as the API hashes them. `verifyG3Sale` judges the
  presented bytes against the buyer's own chain reads before anything is
  signed, naming every departure: the P-leg against the request (insured
  key, feed, class, strike, coverage, term, payout), the markers of the spent
  Head, the core pins, the legs, the buyer's outflow against the quote, the
  collateral, anything foreign (script inputs, signers, withdrawals,
  certificates, mints), the window against the referenced reading, the
  protocol fee, the Treasury donation, the network, and phase one (balance,
  fee, min-UTxO, size, units, collateral). The first preview sale passes,
  and silencing any one of its 57 conditions lets a one-field mutant of
  that sale through.
  `g3PLegDeposit`, `g3ProtocolFee`, `g3Donation`, `g3DepthBps`,
  `g3SheetCell` and `g3LegPremium` size and price a sale as the validator
  does; `G3_PREVIEW_ADA` is the preview ADA instance.
- **Chain reads** — `readResolvedOutputs` reads every output a transaction
  names from Koios; `addressBytes` / `addressHex` convert between bech32 and
  output address bytes; `outRefDigest` is the out-ref hash a FluidTokens loan
  and a gen-3 position are named by.
- **`FluidV4Suite`** also carries the pool policy, pool spend script, borrow
  action script and both bond policies its config names.
- **`encodePlutusData`** — writes Plutus Data with definite lengths, a bignum
  past a machine word, and a constructor under tags 121-127, 1280-1400 or 102;
  `decodePlutusData` reads back every value it writes.
- **Zero-premium-cover enrollment addresses** — `hybridStakeAddress(paymentVkh,
  stakeScriptHashHex, network)` encodes the CIP-19 type-2 base address
  (key payment + SCRIPT stake) the enrollment places principal at, and
  `scriptStakeAddress(stakeScriptHashHex, network)` encodes the per-enrollee
  script reward account (type 15, `stake`/`stake_test` HRP). Goldens are
  pycardano 0.13.1 output so the SDK and the backend enroll build response
  can never disagree on where the principal lives.

- **N2 Event-class cover** — no new composer and **no new risk class**: event
  cover is a `Barrier` underwrite bound to an `EVENT_SLOT` feed (`feeds.ts`,
  `kind:'event'`). `buildUnderwriteParts` already composes it; `event_golden.test.ts`
  locks the EVENT_SLOT underwrite byte-for-byte (the policy datum is identical to
  the ADA barrier golden except the oracle NFT). Adds a thin ergonomic wrapper
  `buildEventUnderwriteParts` that defaults `riskClass:'Barrier'` and resolves the
  EVENT_SLOT feed NFT (accepts a registry symbol or a raw 28-byte policy id) — it
  forwards to `buildUnderwriteParts` and adds **no** composition logic.
- **`decodeEventDatum(raw)`** reads the on-chain EVENT_SLOT feed datum — the SAME
  Charli3 GenericData wire form `decodeFearDatum` handles
  (`Tag 121([Tag 123([{0: value, 1: created_ms, 2: expiry_ms}])])`) — into
  `{ value, createdMs, expiryMs }`. Golden vectors are byte-for-byte the Python
  publisher output; accepts hex or bytes and both the definite and indefinite
  array forms. The raw CBOR walk was extracted into `generic_data.ts`
  (`readGenericData`) so `decodeFearDatum` and `decodeEventDatum` share one reader
  and cannot drift — **no datum format was invented**.
- **`isTriggered(value, strike = 0n)`** — the `value ≤ strike` settlement
  predicate (a binary feed struck at 0: value 0 = liquidated ⇒ triggered, value 1
  = alive ⇒ not). Boundary-tested (closed at `value == strike`).
- **Event pricing reuses the barrier quote**: `quoteEventCover` is a documented
  re-export of `quoteBarrier` (a binary liquidation event is a barrier struck at
  the liquidation level; the floor table is asset-independent) — **no separate
  `quoteEvent` model** to maintain.

Changed:

- **`Network` takes `'preview'`.** The public `Network` union is
  `'mainnet' | 'preprod' | 'preview'`. Code that switches exhaustively on a
  `Network` fails to typecheck until it handles `'preview'`, as does a
  `Record<Network, T>` it fills without a `preview` entry. `aegisBindings`
  takes `'mainnet' | 'preprod'`, so a value typed `Network` no longer passes
  to it; called from untyped code with any other network, it throws
  `InputError` with code `INVALID_INPUT` and message
  `there is no Aegis deployment on <network>` instead of returning preprod's
  bindings.
- **Hex input must be hex digits.** Given a hex string holding a character
  that is not a hex digit, `readGenericData` (so `decodeFearDatum` and
  `decodeEventDatum`) and `decodePlutusData` (so `decodeFluidSuite` and
  `decodeFluidLoanDatum`) now throw `InputError` with code `INVALID_INPUT` and
  message `GenericData hex holds a character that is no hex digit`, before any
  CBOR is read. They used to turn each two-character pair into the byte
  `parseInt(pair, 16)` gave and decode that: a pair opening with a non-hex
  character became `00`, a digit then a non-hex character became that digit
  alone (`1g` became `01`), and a sign or a space was honoured (`-1` became
  `ff`, ` 1` became `01`). A corrupted datum could so decode to another value,
  or fail later with a CBOR error. A `Uint8Array`, and hex of digits alone in
  either case, read as before.
- **`rh1CoverParams` floors `distanceBps` for a line of either sign.** When
  the loan's lTV or the collateral price passed in is negative, the line it
  divides by is negative, and the quotient used to come out wrong; it is now
  the floor the field documents. Positive lines read as before.

## 1.0.5-v4.0 — crashShieldFeedFor underlying-ticker helper (2026-06-24)

Additive (no breaking changes):

- **`crashShieldFeedFor(underlying, network?)`** — sugar over `findFeed` that
  maps an underlying ticker (`'ADA'`, `'BTC'`, `'ETH'`) to its `*_USD` **spot**
  (Barrier) feed on the target network. Case-insensitive; also accepts the full
  `_USD` symbol. Returns `undefined` for non-crash-shield underlyings
  (depeg/relay/event) and unknowns. `crashShieldFeedFor('ADA', 'preprod')` →
  the live preprod ADA/USD feed `d2f08410…`.

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
