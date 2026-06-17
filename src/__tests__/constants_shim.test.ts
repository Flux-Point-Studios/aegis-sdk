// The legacy top-level `constants.ts` is now a thin network-aware shim that
// re-exports the active network's frozen-manifest constants. Default is
// preprod; mainnet selection is opt-in via `AEGIS_NETWORK` env (build flag).

import { describe, it, expect } from 'vitest';

describe('constants.ts shim', () => {
  it('exposes the preprod manifest constants by default', async () => {
    // Pinned to the live pool-funded preprod deployment (AEGIS_POOL_12H_V1,
    // release/preprod.json frozen 2026-06-17). If this changes, preprod was
    // redeployed and the SDK constants must be re-synced from the manifest.
    const c = await import('../constants');
    expect(c.AEGIS_NETWORK).toBe('preprod');
    expect(c.AEGIS_POOL_NFT_POLICY_ID).toBe(
      'da986312812002c71c24a04156c61e65b7e38bb2f81322618eff2725',
    );
    expect(c.AEGIS_MIN_PREMIUM).toBe(2_000_000n);
  });

  it('exposes the live mainnet manifest constants', async () => {
    // Pinned to the live V4 pool-funded mainnet pool (AEGIS_POOL_V4,
    // release/mainnet.json frozen 2026-06-15) — the deployment partners
    // integrate against. A change here means a mainnet redeploy + re-sync.
    const mn = await import('../constants.mainnet');
    expect(mn.AEGIS_POOL_NFT_POLICY_ID).toBe(
      '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3',
    );
    expect(mn.AEGIS_POOL_ADDRESS).toBe(
      'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr',
    );
    expect(mn.AEGIS_MIN_PREMIUM).toBe(20_000_000n);
  });
});
