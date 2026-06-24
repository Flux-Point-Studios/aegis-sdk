// Named registry of the canonical Aegis mainnet oracle feeds.
//
// An Underwrite binds a policy to ONE oracle feed via `oraclePolicyId` (the
// 28-byte NFT policy id the publisher republishes the price under). Rather than
// pasting a raw hex string, look the feed up by symbol:
//
//   import { FEEDS } from '@fluxpointstudios/aegis-sdk';
//   buildUnderwriteParts({ oraclePolicyId: FEEDS.ADA_USD.policyId, riskClass: FEEDS.ADA_USD.riskClass, … })
//
// `MAINNET_FEEDS` are the live mainnet feeds. `PREPROD_FEEDS` are the live
// preprod publisher feeds (different NFTs, same asset names — verified on-chain).
// Use the network-aware helpers `feedsFor(network)` / `findFeed(symbol, network)`
// so preprod consumers don't have to hardcode the preprod NFT.
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

/** Networks that have a published Aegis feed set. */
export type FeedNetwork = 'mainnet' | 'preprod';

// Per-symbol preprod feed NFT policy ids. The publisher republishes the same
// feeds on preprod under DIFFERENT one-shot NFTs (the mint policy is
// parameterized over a per-network init UTxO), but the same asset names —
// each entry below was confirmed against the preprod NFT's on-chain asset
// name (e.g. d2f08410… mints `AEGIS_PRICE_FEED_V1`). `IUSD_USD` is absent: no
// preprod iUSD relay feed is published, so it has no preprod entry (consumers
// pass it explicitly or stay on mainnet).
const PREPROD_POLICY_IDS: Readonly<Record<string, string>> = {
  ADA_USD: 'd2f08410f9f999b2afff902ec4ef47cc7b1677709887d20e0f13938f',
  BTC_USD: 'ae304e27806536dbbc222115c2b543e845f99bd8c7a3a01669f2d7bd',
  ETH_USD: 'd80aa1a72a46813b5045e163751076d54551fac4a6f8d720e15807ad',
  USDC_USD: '860faa663d8a3ae3071d61f95464340c0e49c1f47f56db76441df7a0',
  USDT_USD: 'a4093bfc7758b86ca1b96df842367bce96cb954650a392020246c0cb',
  EVENT_SLOT_1: '7b53817a1cda197ca26883a25adb51631f3368094c721751ae9ceb23',
  EVENT_SLOT_2: '6ee32803e472cbc636bf0d7073f1f54ad0f73b536c69b1f0d6771fe4',
  EVENT_SLOT_3: '485eea6e0f21b6eac798088f9ca8a2aca5bd88efd6f176d9b9a2a53f',
  EVENT_SLOT_4: '544ddf337bdbbe27962de6d62c6177043b3ef6d229ee2b641c480025',
};

// Derived from MAINNET_FEEDS so symbol/assetName/kind/riskClass/description
// stay in lockstep with their mainnet twin — only `policyId` differs. Order
// follows MAINNET_FEEDS (minus the absent IUSD_USD), matching the preprod
// publisher's canonical-NFT order.
export const PREPROD_FEEDS: readonly OracleFeed[] = MAINNET_FEEDS
  .filter((f) => f.symbol in PREPROD_POLICY_IDS)
  .map((f) => ({ ...f, policyId: PREPROD_POLICY_IDS[f.symbol] }));

/** The feed registry for a network. */
export function feedsFor(network: FeedNetwork): readonly OracleFeed[] {
  return network === 'preprod' ? PREPROD_FEEDS : MAINNET_FEEDS;
}

/** Look a feed up by symbol on a given network (defaults to mainnet). */
export function findFeed(
  symbol: string,
  network: FeedNetwork = 'mainnet',
): OracleFeed | undefined {
  return feedsFor(network).find((f) => f.symbol === symbol);
}

/** Crash-Shield feed for an underlying ticker — sugar over `findFeed`.
 *
 * Crash Shield is Barrier coverage on a volatile asset's spot price, so this
 * resolves an underlying (`'ADA'`, `'BTC'`, `'ETH'`) to its `*_USD` **spot**
 * feed on the target network. Case-insensitive; also accepts the full `_USD`
 * symbol. Returns `undefined` for non-spot underlyings (depeg/relay/event
 * feeds are not crash-shield) and unknowns.
 *
 *     crashShieldFeedFor('ADA')             // mainnet ADA/USD spot (Barrier)
 *     crashShieldFeedFor('ADA', 'preprod')  // preprod ADA/USD (d2f08410…)
 */
export function crashShieldFeedFor(
  underlying: string,
  network: FeedNetwork = 'mainnet',
): OracleFeed | undefined {
  const u = underlying.toUpperCase();
  const symbol = u.endsWith('_USD') ? u : `${u}_USD`;
  const feed = findFeed(symbol, network);
  return feed?.kind === 'spot' ? feed : undefined;
}

/** All generic (non-`event`) feeds — the building blocks any dApp can use. */
export const GENERIC_FEEDS: readonly OracleFeed[] = MAINNET_FEEDS.filter(
  (f) => f.kind !== 'event',
);

/** Feeds of a given kind. */
export function feedsByKind(kind: FeedKind): OracleFeed[] {
  return MAINNET_FEEDS.filter((f) => f.kind === kind);
}

/** Reverse-lookup a feed by its 28-byte policy id (hex), across networks
 * (mainnet first for back-compat, then preprod). */
export function findFeedByPolicyId(policyId: string): OracleFeed | undefined {
  return (
    MAINNET_FEEDS.find((f) => f.policyId === policyId) ??
    PREPROD_FEEDS.find((f) => f.policyId === policyId)
  );
}
