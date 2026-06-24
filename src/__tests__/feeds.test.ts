import { describe, it, expect } from 'vitest';
import {
  MAINNET_FEEDS,
  PREPROD_FEEDS,
  FEEDS,
  GENERIC_FEEDS,
  feedsByKind,
  feedsFor,
  findFeed,
  findFeedByPolicyId,
} from '../feeds';
import { AEGIS_PUBLISHER_CANONICAL_NFTS } from '../constants.mainnet';
import { AEGIS_PUBLISHER_CANONICAL_NFTS as PREPROD_CANONICAL_NFTS } from '../constants.preprod';

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

describe('preprod feed registry (network-aware lookup)', () => {
  // Authoritative: each preprod NFT's on-chain asset name was resolved on
  // preprod and matches the mainnet feed's asset name 1:1. Only IUSD_USD has
  // no preprod feed (no preprod iUSD relay published), so PREPROD_FEEDS is the
  // 9 of 10 mainnet feeds that exist on preprod, in the same order.
  it('matches the preprod publisher canonical-NFT set byte-for-byte and in order', () => {
    const canonical = PREPROD_CANONICAL_NFTS.map((u) => u.replace(/\.$/, ''));
    expect(PREPROD_FEEDS.map((f) => f.policyId)).toEqual(canonical);
  });

  it('every preprod policy id is a 28-byte (56 hex) lowercase string', () => {
    for (const f of PREPROD_FEEDS) {
      expect(f.policyId).toMatch(/^[0-9a-f]{56}$/);
    }
  });

  it('the preprod ADA/USD pin is the live publisher feed (d2f08410…)', () => {
    expect(findFeed('ADA_USD', 'preprod')?.policyId).toBe(
      'd2f08410f9f999b2afff902ec4ef47cc7b1677709887d20e0f13938f',
    );
  });

  it('findFeed defaults to mainnet and switches by network', () => {
    expect(findFeed('ADA_USD')?.policyId).toBe(FEEDS.ADA_USD.policyId);
    expect(findFeed('ADA_USD', 'mainnet')?.policyId).toBe(FEEDS.ADA_USD.policyId);
    expect(findFeed('ADA_USD', 'preprod')?.policyId).not.toBe(FEEDS.ADA_USD.policyId);
  });

  it('feedsFor returns the right registry per network', () => {
    expect(feedsFor('mainnet')).toBe(MAINNET_FEEDS);
    expect(feedsFor('preprod')).toBe(PREPROD_FEEDS);
  });

  it('IUSD_USD has no preprod feed', () => {
    expect(findFeed('IUSD_USD', 'preprod')).toBeUndefined();
    expect(PREPROD_FEEDS.find((f) => f.symbol === 'IUSD_USD')).toBeUndefined();
  });

  it('preprod feeds share all metadata with their mainnet twin except policyId', () => {
    for (const pf of PREPROD_FEEDS) {
      const mf = FEEDS[pf.symbol];
      expect(mf).toBeDefined();
      expect(pf.assetName).toBe(mf.assetName);
      expect(pf.kind).toBe(mf.kind);
      expect(pf.riskClass).toBe(mf.riskClass);
      expect(pf.policyId).not.toBe(mf.policyId);
    }
  });

  it('reverse-lookup resolves preprod NFTs too', () => {
    expect(
      findFeedByPolicyId('d2f08410f9f999b2afff902ec4ef47cc7b1677709887d20e0f13938f')?.symbol,
    ).toBe('ADA_USD');
  });
});
