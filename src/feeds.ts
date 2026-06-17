// Named registry of the canonical Aegis mainnet oracle feeds.
//
// An Underwrite binds a policy to ONE oracle feed via `oraclePolicyId` (the
// 28-byte NFT policy id the publisher republishes the price under). Rather than
// pasting a raw hex string, look the feed up by symbol:
//
//   import { FEEDS } from '@fluxpointstudios/aegis-sdk';
//   buildUnderwriteParts({ oraclePolicyId: FEEDS.ADA_USD.policyId, riskClass: FEEDS.ADA_USD.riskClass, … })
//
// These are the LIVE MAINNET feeds. Preprod test feeds are different NFTs and
// are not listed here — pass the preprod feed NFT explicitly when testing.
//
// `spot` / `depeg` / `relay` feeds are generic: any dApp insuring that
// underlying uses them directly. `event` feeds are bespoke — each emits a
// binary alive/liquidated value for one integrated market's liquidation event,
// so they are only meaningful to the integration they were provisioned for.

import type { RiskClass } from './types';

export type FeedKind = 'spot' | 'depeg' | 'relay' | 'event';

export interface OracleFeed {
  /** Stable symbol you reference in code (e.g. `FEEDS.ADA_USD`). */
  symbol: string;
  /** 28-byte oracle NFT policy id (hex) — pass as `oraclePolicyId`. */
  policyId: string;
  /** On-chain asset name the feed NFT is minted under (UTF-8). */
  assetName: string;
  /** Feed kind. `spot`/`depeg`/`relay` are generic; `event` is bespoke. */
  kind: FeedKind;
  /** RiskClass to underwrite against this feed (PolicyDatum field 14). */
  riskClass: RiskClass;
  /** Human-readable description. */
  description: string;
}

// The canonical mainnet feed set (order matches the publisher's republish
// manifest). Verified against api/.../measure_publisher_burn.py FEEDS and
// constants.mainnet.ts AEGIS_PUBLISHER_CANONICAL_NFTS.
export const MAINNET_FEEDS: readonly OracleFeed[] = [
  {
    symbol: 'ADA_USD',
    policyId: 'f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301',
    assetName: 'AEGIS_PRICE_FEED_V1',
    kind: 'spot',
    riskClass: 'Barrier',
    description: 'ADA/USD spot price — the primary barrier feed.',
  },
  {
    symbol: 'BTC_USD',
    policyId: '99e8fe4f9d2a4a85f5e3f20d37b10048ce54e4a03e56d9fd492163b3',
    assetName: 'AEGIS_PRICE_FEED_BTC_USD_V1',
    kind: 'spot',
    riskClass: 'Barrier',
    description: 'BTC/USD spot price.',
  },
  {
    symbol: 'ETH_USD',
    policyId: 'a8c5354a4813f2b3f60836839b8842a9422186f4f15511790ec95f9c',
    assetName: 'AEGIS_PRICE_FEED_ETH_USD_V1',
    kind: 'spot',
    riskClass: 'Barrier',
    description: 'ETH/USD spot price.',
  },
  {
    symbol: 'USDC_USD',
    policyId: 'a8231f0c10b514659fd590f6ee7420acf4e145cce36909a7f5fe1c5e',
    assetName: 'AEGIS_PRICE_FEED_USDC_USD_V1',
    kind: 'depeg',
    riskClass: 'Depeg',
    description: 'USDC/USD — depeg coverage feed.',
  },
  {
    symbol: 'USDT_USD',
    policyId: '82a324a3de0be7bc9c4b8450db5350cf0479fa1393eb8eee2481c652',
    assetName: 'AEGIS_PRICE_FEED_USDT_USD_V1',
    kind: 'depeg',
    riskClass: 'Depeg',
    description: 'USDT/USD — depeg coverage feed.',
  },
  {
    symbol: 'IUSD_USD',
    policyId: 'f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02',
    assetName: 'AEGIS_PRICE_FEED_IUSD_USD_V1',
    kind: 'relay',
    riskClass: 'Barrier',
    description: 'iUSD/USD price relay — for any protocol pricing iUSD.',
  },
  {
    symbol: 'EVENT_SLOT_1',
    policyId: 'c2f62874c860e1fc87bae0043066e551153f30fcc5d9944a370e8f8d',
    assetName: 'AEGIS_PRICE_FEED_SURF1_EVT_V1',
    kind: 'event',
    riskClass: 'Barrier',
    description: 'Event-coverage slot — binary alive/liquidated value for one integrated market (provisioned per integration).',
  },
  {
    symbol: 'EVENT_SLOT_2',
    policyId: 'f4e78f3636248838c2d5c6578062cfb78f385482b0078de7aff5cc3b',
    assetName: 'AEGIS_PRICE_FEED_SURF2_EVT_V1',
    kind: 'event',
    riskClass: 'Barrier',
    description: 'Event-coverage slot — binary alive/liquidated value for one integrated market (provisioned per integration).',
  },
  {
    symbol: 'EVENT_SLOT_3',
    policyId: '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f',
    assetName: 'AEGIS_PRICE_FEED_SURF3_EVT_V1',
    kind: 'event',
    riskClass: 'Barrier',
    description: 'Event-coverage slot — binary alive/liquidated value for one integrated market (provisioned per integration).',
  },
  {
    symbol: 'EVENT_SLOT_4',
    policyId: '47c16934540cdead6045f947b1a7fd4b910bc0352a269b11800d0bed',
    assetName: 'AEGIS_PRICE_FEED_SURF4_EVT_V1',
    kind: 'event',
    riskClass: 'Barrier',
    description: 'Event-coverage slot — binary alive/liquidated value for one integrated market (provisioned per integration).',
  },
] as const;

/** Ergonomic lookup by symbol: `FEEDS.ADA_USD.policyId`. */
export const FEEDS: Readonly<Record<string, OracleFeed>> = Object.freeze(
  Object.fromEntries(MAINNET_FEEDS.map((f) => [f.symbol, f])),
);

/** All generic (non-`event`) feeds — the building blocks any dApp can use. */
export const GENERIC_FEEDS: readonly OracleFeed[] = MAINNET_FEEDS.filter(
  (f) => f.kind !== 'event',
);

/** Feeds of a given kind. */
export function feedsByKind(kind: FeedKind): OracleFeed[] {
  return MAINNET_FEEDS.filter((f) => f.kind === kind);
}

/** Reverse-lookup a feed by its 28-byte policy id (hex). */
export function findFeedByPolicyId(policyId: string): OracleFeed | undefined {
  return MAINNET_FEEDS.find((f) => f.policyId === policyId);
}
