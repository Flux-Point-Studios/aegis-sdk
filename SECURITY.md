# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

- Preferred: GitHub → the **Security** tab → **Report a vulnerability** (private
  advisory).
- Or email **fluxpointstudios@gmail.com** with `[aegis-sdk security]` in the
  subject.

We aim to acknowledge within 72 hours and to coordinate a fix and disclosure
timeline with you. Please include a description, affected version, and a
minimal reproduction if possible.

## Supported versions

The latest published `@fluxpointstudios/aegis-sdk` release on npm is supported.
Pre-1.0 versions are not.

## Security posture of this SDK

This SDK is deliberately small and conservative:

- **Zero runtime dependencies.** Nothing is pulled in at install or run time, so
  the supply-chain surface is just the source in this repo. The only npm
  lifecycle script is `prepublishOnly` (a build); there is no `postinstall` or
  other install-time code execution.
- **It never handles secrets.** The SDK does not take, store, derive, or
  transmit seed phrases, private keys, or mnemonics. Signing happens entirely in
  the partner's own wallet / transaction builder (CIP-30, MeshJS, Lucid). The
  SDK only produces transaction *parts* (datums, redeemers, output values).
- **No network or chain access by default.** `buildUnderwriteParts`,
  `quoteForPosition`, the CBOR codecs, and the math are all pure functions. The
  one optional network helper, `fetchQuote`, only `POST`s to the public Aegis
  pricing API and never sends credentials.
- **Validator-exact, integer-only money math.** The premium floor, fee split,
  and treasury cut mirror the on-chain Aiken validators using `bigint`
  arithmetic (no floats), so the SDK can never silently under-price below the
  on-chain floor. These are covered by differential tests against the live
  validator/pricer and a byte-exact golden against a real on-chain policy.
- **Only public data is bundled.** `constants.<network>.ts` contains deployed
  script hashes, addresses, pool/oracle NFT policy ids, and reference-script
  UTxOs — all of which are already public on-chain.

## Using the SDK safely

- Always verify a quote with `quoteForPosition` (or `preflightUnderwrite`)
  before composing, and inspect the returned parts before signing.
- Re-fetch the live pool UTxO immediately before building; call
  `assertPoolMatchesManifest` to catch a pool redeploy.
- Pin the SDK version and review the lockfile in your own project.
