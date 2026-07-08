// The legacy top-level `constants.ts` is now a thin network-aware shim that
// re-exports the active network's frozen-manifest constants. Default is
// preprod; mainnet selection is opt-in via `AEGIS_NETWORK` env (build flag).

import { describe, it, expect } from 'vitest';

describe('constants.ts shim', () => {
  it('exposes the preprod manifest constants by default', async () => {
    // Pinned to the live pool-funded preprod deployment (AEGIS_POOL_V4,
    // release/preprod.json release_commit 7097ee1). If this changes, preprod was
    // redeployed and the SDK constants must be re-synced from the manifest.
    const c = await import('../constants');
    expect(c.AEGIS_NETWORK).toBe('preprod');
    expect(c.AEGIS_POOL_NFT_POLICY_ID).toBe(
      '2b8d7869526eb5af6b7e7ff08c55b345f16e6eca9079e3f429325a05',
    );
    expect(c.AEGIS_MIN_PREMIUM).toBe(2_000_000n);
  });

  it('exposes the live mainnet manifest constants', async () => {
    // Pinned to the live V7 general pool (AEGIS_POOL_V7, conditional donation,
    // release/mainnet-v7.json) — the pool partners (incl. SaturnSwap insured
    // swaps) integrate against. A change here means a mainnet redeploy + re-sync.
    const mn = await import('../constants.mainnet');
    expect(mn.AEGIS_POOL_NFT_POLICY_ID).toBe(
      'a48f89cf5a52226a2f8226b1af033507594ded136031575a3b028154',
    );
    expect(mn.AEGIS_POOL_ADDRESS).toBe(
      'addr1w9926sf0nqczu6494fwz00cq8jlzqds6kfm0h2geh7kd2qs70dmj2',
    );
    expect(mn.AEGIS_MIN_PREMIUM).toBe(20_000_000n);
  });
});
