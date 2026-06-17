import { describe, it, expect } from 'vitest';
import {
  MAINNET_FEEDS,
  FEEDS,
  GENERIC_FEEDS,
  feedsByKind,
  findFeedByPolicyId,
} from '../feeds';
import { AEGIS_PUBLISHER_CANONICAL_NFTS } from '../constants.mainnet';

describe('mainnet feed registry', () => {
  it('matches the publisher canonical-NFT set byte-for-byte and in order', () => {
    // constants.mainnet.ts stores them as `<policyid>.` (unit with empty asset).
    const canonical = AEGIS_PUBLISHER_CANONICAL_NFTS.map((u) => u.replace(/\.$/, ''));
    expect(MAINNET_FEEDS.map((f) => f.policyId)).toEqual(canonical);
  });

  it('every policy id is a 28-byte (56 hex) lowercase string', () => {
    for (const f of MAINNET_FEEDS) {
      expect(f.policyId).toMatch(/^[0-9a-f]{56}$/);
    }
  });

  it('symbols are unique', () => {
    const syms = MAINNET_FEEDS.map((f) => f.symbol);
    expect(new Set(syms).size).toBe(syms.length);
  });

  it('the canonical pin (the price/depeg/relay mappings the spec depends on)', () => {
    expect(FEEDS.ADA_USD.policyId).toBe('f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301');
    expect(FEEDS.BTC_USD.policyId).toBe('99e8fe4f9d2a4a85f5e3f20d37b10048ce54e4a03e56d9fd492163b3');
    expect(FEEDS.ETH_USD.policyId).toBe('a8c5354a4813f2b3f60836839b8842a9422186f4f15511790ec95f9c');
    expect(FEEDS.USDC_USD.policyId).toBe('a8231f0c10b514659fd590f6ee7420acf4e145cce36909a7f5fe1c5e');
    expect(FEEDS.USDT_USD.policyId).toBe('82a324a3de0be7bc9c4b8450db5350cf0479fa1393eb8eee2481c652');
    expect(FEEDS.IUSD_USD.policyId).toBe('f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02');
  });

  it('risk-class assignment follows the underlying', () => {
    expect(FEEDS.ADA_USD.riskClass).toBe('Barrier');
    expect(FEEDS.USDC_USD.riskClass).toBe('Depeg');
    expect(FEEDS.USDT_USD.riskClass).toBe('Depeg');
    expect(FEEDS.IUSD_USD.riskClass).toBe('Barrier');
  });

  it('GENERIC_FEEDS excludes the bespoke event slots', () => {
    expect(GENERIC_FEEDS.every((f) => f.kind !== 'event')).toBe(true);
    expect(GENERIC_FEEDS).toHaveLength(6);
    expect(feedsByKind('event')).toHaveLength(4);
    expect(feedsByKind('spot')).toHaveLength(3);
    expect(feedsByKind('depeg')).toHaveLength(2);
  });

  it('reverse-lookup by policy id resolves to the right feed', () => {
    expect(findFeedByPolicyId(FEEDS.ADA_USD.policyId)?.symbol).toBe('ADA_USD');
    expect(findFeedByPolicyId('deadbeef')).toBeUndefined();
  });
});
