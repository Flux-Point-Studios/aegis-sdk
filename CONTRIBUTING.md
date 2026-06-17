# Contributing

Thanks for your interest in `@fluxpointstudios/aegis-sdk`.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest
npm run build       # dual ESM + CJS to dist/
```

## Ground rules

- **Zero runtime dependencies.** Do not add a runtime `dependency`. Dev-only
  tooling is fine.
- **Validator-exact, integer-only money math.** Premium floor, fee split, and
  treasury cut mirror the on-chain Aiken validators with `bigint` (no floats).
  If the on-chain tables change, regenerate the mirror and update the
  cell-pin tests in lockstep — the SDK must never hold a floor the chain
  doesn't.
- **Real tests, not "good vibes."** New behavior needs a test that would fail
  without the change: golden-vs-chain, differential-vs-validator/pricer, or an
  adversarial negative. Keep CBOR byte-form exact (CIP-30 wallet round-trip).
- **Surgical changes.** Match the surrounding style; touch only what the change
  requires.
- **Never commit secrets.** No keys, seed phrases, tokens, or `.env`. The SDK
  handles none of these by design.

## Pull requests

Open a PR against `main`. CI runs typecheck + tests + build on Node 18/20/22 and
must pass. Describe the change and link any related issue.

For security issues, see [SECURITY.md](./SECURITY.md) — please report privately.
