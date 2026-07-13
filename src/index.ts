// Public entry point for the @fluxpointstudios/aegis-sdk package (R17 baseline).
//
// Quick start:
//   import { AegisSDK, calculatePremium } from '@fluxpointstudios/aegis-sdk';
//   const aegis = new AegisSDK();
//   const out = aegis.buildPolicyOutput({ ... });

// ---------------------------------------------------------------------------
// SDK facade
// ---------------------------------------------------------------------------
export { AegisSDK } from './aegis';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
export { calculatePremium } from './pricing';

// ---------------------------------------------------------------------------
// V4 premium floor — validator-exact mirror of contracts/lib/aegis/floor_table.ak
// ---------------------------------------------------------------------------
export {
  MIN_STRIKE_DISTANCE_BPS,
  DEPEG_STRIKE_LO_PCT,
  DEPEG_STRIKE_HI_PCT,
  tBandIndex,
  barrierFloorBps,
  depegFloorBps,
  meetsBarrierFloor,
  meetsDepegFloor,
  depegStrikeInBand,
  barrierDBps,
  durationDays,
} from './floor_table';

// ---------------------------------------------------------------------------
// Verify-only insurability quote — fail-fast mirror of api/pricing_engine.py
// gates + the on-chain floor (does the chain accept this exact policy?).
// ---------------------------------------------------------------------------
export {
  quoteBarrier,
  quoteDepeg,
  quoteForPosition,
  DEAD_ZONE_SHALLOW_D_BPS,
  DEAD_ZONE_SHALLOW_T,
  DEAD_ZONE_MID_D_BPS,
  DEAD_ZONE_MID_T,
} from './quote';
export type { QuoteVerdict } from './quote';

// ---------------------------------------------------------------------------
// Fee / treasury math (validator-exact, bigint) + script/key address encoders
// ---------------------------------------------------------------------------
export {
  calculateFeeTotal,
  calculateNetPoolGrowth,
  calculateProtocolFeeSplit,
  calculateTreasuryCut,
  TREASURY_SHARE_BPS,
  TREASURY_SWEEP_SHARE_BPS,
} from './fees';
export {
  scriptEnterpriseAddress,
  keyAddress,
  scriptPayoutTarget,
  hybridStakeAddress,
  scriptStakeAddress,
} from './address';
export type { Network } from './address';

// ---------------------------------------------------------------------------
// Treasury-donation sweep (Phase 4 decouple) — the periodic key-witnessed tx
// that batches the treasury's cut off the swap path (no PlutusV2 script).
// ---------------------------------------------------------------------------
export {
  buildTreasurySweepParts,
  reconcileTreasurySweep,
  treasuryCutForAccrual,
} from './treasury_sweep';
export type {
  TreasuryAccrual,
  TreasurySweepParts,
  BuildTreasurySweepPartsParams,
} from './treasury_sweep';

// ---------------------------------------------------------------------------
// Pool-funded Underwrite composer — the one-click "add insurance" primitive
// partners splice into their own loan/CDP tx.
// ---------------------------------------------------------------------------
export {
  buildUnderwriteParts,
  buildAddLiquidityParts,
  buildRemoveLiquidityParts,
  calculateLpMint,
  calculateWithdrawal,
  aegisBindings,
  preflightUnderwrite,
  assertPoolMatchesManifest,
} from './compose';
export type {
  AegisBindings,
  LivePoolState,
  BuildUnderwritePartsParams,
  UnderwriteParts,
  PolicyOutputPart,
  PoolOutputPart,
  FeeOutputPart,
  MintPart,
  MarkerAsset,
  RefUtxo,
  PreflightCheck,
  PreflightResult,
  BuildAddLiquidityPartsParams,
  AddLiquidityParts,
  BuildRemoveLiquidityPartsParams,
  RemoveLiquidityParts,
  LpAsset,
  LpProviderOutputPart,
  LpMintPart,
  VaultReferences,
} from './compose';
export {
  buildFundVaultParts,
  buildOwnerSweepParts,
  nextVaultDatumForSpend,
} from './vault';
export type {
  FundVaultPartsParams,
  FundVaultParts,
  VaultOutputPart,
  OwnerSweepPartsParams,
  OwnerSweepParts,
} from './vault';
export type { AgentVaultDatum, AgentVaultRedeemerKind } from './types';

// ---------------------------------------------------------------------------
// Canonical policy_id derivation (BLAKE2b-224) — matches the Aegis claim
// indexer's key, so composed policies are first-class in /api/policies.
// ---------------------------------------------------------------------------
export { blake2b, blake2b224, derivePolicyId } from './blake2b';

// ---------------------------------------------------------------------------
// T7 AEGIS/FEAR index — on-chain fear-gauge datum decoder + band classifier.
// The 0-100 fear score is computed API-side (api/fear_index.py) and published
// on chain as a Charli3-compatible GenericData datum; this reads it back.
// ---------------------------------------------------------------------------
export { decodeFearDatum, classifyFear } from './fear';
export type { FearReading, FearBand } from './fear';

// ---------------------------------------------------------------------------
// N2 Event-class cover — read the on-chain binary event state + compose an
// event underwrite. Event cover is a Barrier underwrite (NO new risk class)
// bound to an EVENT_SLOT feed; the event datum is the SAME Charli3 GenericData
// wire form the FEAR gauge / price oracle use (no new datum format), and event
// pricing reuses quoteBarrier (quoteEventCover is a documented re-export).
// ---------------------------------------------------------------------------
export {
  decodeEventDatum,
  isTriggered,
  quoteEventCover,
  buildEventUnderwriteParts,
  EVENT_FEEDS,
} from './event';
export type { EventReading, BuildEventUnderwritePartsParams } from './event';
export { readGenericData } from './generic_data';
export type { GenericData } from './generic_data';

// ---------------------------------------------------------------------------
// Named oracle-feed registry (mainnet + preprod, network-aware lookup).
// ---------------------------------------------------------------------------
export {
  MAINNET_FEEDS,
  PREPROD_FEEDS,
  FEEDS,
  GENERIC_FEEDS,
  feedsByKind,
  feedsFor,
  findFeed,
  crashShieldFeedFor,
  findFeedByPolicyId,
} from './feeds';
export type { OracleFeed, FeedKind, FeedNetwork } from './feeds';

// ---------------------------------------------------------------------------
// Developer experience: typed errors, chain/wallet error decoding, formatters,
// and an optional quote-fetch helper.
// ---------------------------------------------------------------------------
export {
  AegisError,
  InputError,
  InsurabilityError,
  PoolError,
  ChainError,
} from './errors';
export type { AegisErrorCode, AegisErrorCategory, AegisErrorOptions } from './errors';
export { decodeChainError } from './decode';
export type { DecodedChainError } from './decode';
export { formatAda, formatUsdScaled, formatParts } from './format';
export { fetchQuote } from './fetch_quote';
export type { FetchQuoteParams, FetchQuoteOptions, FetchedQuote, MinimalFetch } from './fetch_quote';

// ---------------------------------------------------------------------------
// CBOR encoders and decoders
// ---------------------------------------------------------------------------
export {
  // Datum
  encodePolicyDatum,
  encodePoolDatum,
  decodePoolDatum,
  encodeAgentVaultDatum,
  decodeAgentVaultDatum,
  encodeAgentVaultRedeemer,
  encodeFullAddress,
  // Redeemers
  encodePolicyRedeemer,
  decodePolicyRedeemer,
  encodePoolRedeemer,
  decodePoolRedeemer,
  encodeLPTokenRedeemer,
  decodeLPTokenRedeemer,
  encodeMarkerRedeemer,
  decodeMarkerRedeemer,
  // Primitives
  encodeConstr,
  encodeInt,
  encodeBytes,
  hexToBytes,
  bytesToHex,
} from './cbor';

// ---------------------------------------------------------------------------
// Manifest-driven constants (active network) + protocol constants
// ---------------------------------------------------------------------------
export {
  AEGIS_NETWORK,
  AEGIS_POOL_ADDRESS,
  AEGIS_POOL_NFT_POLICY_ID,
  AEGIS_POOL_NFT_ASSET_NAME,
  AEGIS_POLICY_VALIDATOR_HASH,
  AEGIS_POOL_VALIDATOR_HASH,
  AEGIS_POLICY_MARKER_HASH,
  AEGIS_LP_TOKEN_HASH,
  AEGIS_POLICY_REF_UTXO,
  AEGIS_POOL_REF_UTXO,
  AEGIS_MARKER_REF_UTXO,
  AEGIS_LP_REF_UTXO,
  AEGIS_TEAM_ADDRESS,
  AEGIS_MIN_PREMIUM,
  AEGIS_TREASURY_SHARE_BPS,
  AEGIS_PUBLISHER_VKH,
  AEGIS_PUBLISHER_CANONICAL_NFTS,
  AEGIS_CHARLI3_ADA_USD_NFT,
  AEGIS_ORCFAX_FSP_HASH,
  // Cross-network protocol constants
  MAX_COVERAGE_RATIO,
  CANCELLATION_WINDOW_MS,
  CANCELLATION_FEE_BPS,
  PRICE_SCALE,
  FEAR_SCALE,
  MIN_UTXO_LOVELACE,
  LOVELACE_PER_ADA,
  DEFAULT_PROTOCOL_FEE_BPS,
  LP_TOKEN_NAME,
  PARTNER_SHARE_CAP_BPS,
} from './constants';

// ---------------------------------------------------------------------------
// Datum / redeemer types (R17 surface)
// ---------------------------------------------------------------------------
export type {
  OracleProvider,
  RiskClass,
  PlutusAddress,
  PlutusCredential,
  PlutusFullAddress,
  PolicyDatum,
  PoolDatum,
  PolicyRedeemer,
  PoolRedeemer,
  LPTokenRedeemer,
  MarkerRedeemer,
  OracleDatum,
  OraclePriceData,
  BuildPolicyParams,
  BuildPolicyOutputParams,
  PolicyOutput,
  PremiumResult,
} from './types';
