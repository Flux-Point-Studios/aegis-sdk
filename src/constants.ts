// Thin network-aware re-export of the active frozen-manifest constants.
//
// Default network is preprod. To target mainnet, set the AEGIS_NETWORK env
// var to "mainnet" before bundling (Vite/Webpack inline this at build time).
// At runtime, the env is also consulted as a fallback for Node consumers.
//
// The per-network files (`constants.preprod.ts`, `constants.mainnet.ts`)
// are owned by `scripts/sync_sdk_constants_from_manifest.py` — do not
// hand-edit them. Add new fields to the manifest schema + the generator,
// not to these files.
//
// Constants that are NOT in the manifest (pure cross-network protocol
// constants such as price_scale, max_coverage_ratio, …) are defined at
// the bottom of this file.

import * as preprod from './constants.preprod';

declare const process:
  | { env?: { [k: string]: string | undefined } }
  | undefined;

function resolveNetwork(): 'preprod' | 'mainnet' {
  const fromEnv =
    typeof process !== 'undefined' && process.env
      ? process.env.AEGIS_NETWORK
      : undefined;
  if (fromEnv === 'mainnet') return 'mainnet';
  return 'preprod';
}

const NETWORK = resolveNetwork();

// ---------------------------------------------------------------------------
// Per-network re-exports
// ---------------------------------------------------------------------------

export const AEGIS_NETWORK = NETWORK;

// Preprod is re-exported eagerly; mainnet is required lazily so a
// preprod-only build doesn't pull in the mainnet constants module.
function preprodConsts() {
  return {
    AEGIS_POOL_ADDRESS: preprod.AEGIS_POOL_ADDRESS,
    AEGIS_POOL_NFT_POLICY_ID: preprod.AEGIS_POOL_NFT_POLICY_ID,
    AEGIS_POOL_NFT_ASSET_NAME: preprod.AEGIS_POOL_NFT_ASSET_NAME,
    AEGIS_POLICY_VALIDATOR_HASH: preprod.AEGIS_POLICY_VALIDATOR_HASH,
    AEGIS_POOL_VALIDATOR_HASH: preprod.AEGIS_POOL_VALIDATOR_HASH,
    AEGIS_POLICY_MARKER_HASH: preprod.AEGIS_POLICY_MARKER_HASH,
    AEGIS_LP_TOKEN_HASH: preprod.AEGIS_LP_TOKEN_HASH,
    AEGIS_POLICY_REF_UTXO: preprod.AEGIS_POLICY_REF_UTXO,
    AEGIS_POOL_REF_UTXO: preprod.AEGIS_POOL_REF_UTXO,
    AEGIS_MARKER_REF_UTXO: preprod.AEGIS_MARKER_REF_UTXO,
    AEGIS_LP_REF_UTXO: preprod.AEGIS_LP_REF_UTXO,
    AEGIS_TEAM_ADDRESS: preprod.AEGIS_TEAM_ADDRESS,
    AEGIS_MIN_PREMIUM: preprod.AEGIS_MIN_PREMIUM,
    AEGIS_TREASURY_SHARE_BPS: preprod.AEGIS_TREASURY_SHARE_BPS,
    AEGIS_PUBLISHER_VKH: preprod.AEGIS_PUBLISHER_VKH,
    AEGIS_PUBLISHER_CANONICAL_NFTS: preprod.AEGIS_PUBLISHER_CANONICAL_NFTS,
    AEGIS_CHARLI3_ADA_USD_NFT: preprod.AEGIS_CHARLI3_ADA_USD_NFT,
    AEGIS_ORCFAX_FSP_HASH: preprod.AEGIS_ORCFAX_FSP_HASH,
  };
}

declare const require: (id: string) => any;

function mainnetConsts() {
  const mn = require('./constants.mainnet');
  return {
    AEGIS_POOL_ADDRESS: mn.AEGIS_POOL_ADDRESS,
    AEGIS_POOL_NFT_POLICY_ID: mn.AEGIS_POOL_NFT_POLICY_ID,
    AEGIS_POOL_NFT_ASSET_NAME: mn.AEGIS_POOL_NFT_ASSET_NAME,
    AEGIS_POLICY_VALIDATOR_HASH: mn.AEGIS_POLICY_VALIDATOR_HASH,
    AEGIS_POOL_VALIDATOR_HASH: mn.AEGIS_POOL_VALIDATOR_HASH,
    AEGIS_POLICY_MARKER_HASH: mn.AEGIS_POLICY_MARKER_HASH,
    AEGIS_LP_TOKEN_HASH: mn.AEGIS_LP_TOKEN_HASH,
    AEGIS_POLICY_REF_UTXO: mn.AEGIS_POLICY_REF_UTXO,
    AEGIS_POOL_REF_UTXO: mn.AEGIS_POOL_REF_UTXO,
    AEGIS_MARKER_REF_UTXO: mn.AEGIS_MARKER_REF_UTXO,
    AEGIS_LP_REF_UTXO: mn.AEGIS_LP_REF_UTXO,
    AEGIS_TEAM_ADDRESS: mn.AEGIS_TEAM_ADDRESS,
    AEGIS_MIN_PREMIUM: mn.AEGIS_MIN_PREMIUM,
    AEGIS_TREASURY_SHARE_BPS: mn.AEGIS_TREASURY_SHARE_BPS,
    AEGIS_PUBLISHER_VKH: mn.AEGIS_PUBLISHER_VKH,
    AEGIS_PUBLISHER_CANONICAL_NFTS: mn.AEGIS_PUBLISHER_CANONICAL_NFTS,
    AEGIS_CHARLI3_ADA_USD_NFT: mn.AEGIS_CHARLI3_ADA_USD_NFT,
    AEGIS_ORCFAX_FSP_HASH: mn.AEGIS_ORCFAX_FSP_HASH,
  };
}

const active = NETWORK === 'preprod' ? preprodConsts() : mainnetConsts();

export const AEGIS_POOL_ADDRESS = active.AEGIS_POOL_ADDRESS;
export const AEGIS_POOL_NFT_POLICY_ID = active.AEGIS_POOL_NFT_POLICY_ID;
export const AEGIS_POOL_NFT_ASSET_NAME = active.AEGIS_POOL_NFT_ASSET_NAME;
export const AEGIS_POLICY_VALIDATOR_HASH = active.AEGIS_POLICY_VALIDATOR_HASH;
export const AEGIS_POOL_VALIDATOR_HASH = active.AEGIS_POOL_VALIDATOR_HASH;
export const AEGIS_POLICY_MARKER_HASH = active.AEGIS_POLICY_MARKER_HASH;
export const AEGIS_LP_TOKEN_HASH = active.AEGIS_LP_TOKEN_HASH;
export const AEGIS_POLICY_REF_UTXO = active.AEGIS_POLICY_REF_UTXO;
export const AEGIS_POOL_REF_UTXO = active.AEGIS_POOL_REF_UTXO;
export const AEGIS_MARKER_REF_UTXO = active.AEGIS_MARKER_REF_UTXO;
export const AEGIS_LP_REF_UTXO = active.AEGIS_LP_REF_UTXO;
export const AEGIS_TEAM_ADDRESS = active.AEGIS_TEAM_ADDRESS;
export const AEGIS_MIN_PREMIUM = active.AEGIS_MIN_PREMIUM;
export const AEGIS_TREASURY_SHARE_BPS = active.AEGIS_TREASURY_SHARE_BPS;
export const AEGIS_PUBLISHER_VKH = active.AEGIS_PUBLISHER_VKH;
export const AEGIS_PUBLISHER_CANONICAL_NFTS = active.AEGIS_PUBLISHER_CANONICAL_NFTS;
export const AEGIS_CHARLI3_ADA_USD_NFT = active.AEGIS_CHARLI3_ADA_USD_NFT;
export const AEGIS_ORCFAX_FSP_HASH = active.AEGIS_ORCFAX_FSP_HASH;

// ---------------------------------------------------------------------------
// Cross-network protocol constants (match contracts/lib/aegis/types.ak)
// ---------------------------------------------------------------------------

/** Max coverage / premium ratio. Pinned by validator (`max_coverage_ratio = 50`). */
export const MAX_COVERAGE_RATIO = 50n;

/** Cancellation window in milliseconds (1 hour). */
export const CANCELLATION_WINDOW_MS = 3_600_000n;

/** Cancellation fee in basis points of the premium (10% retained). */
export const CANCELLATION_FEE_BPS = 1_000n;

/** Charli3 price scale (1e6). */
export const PRICE_SCALE = 1_000_000n;

/** Minimum UTxO lovelace assumed on policy/pool outputs. */
export const MIN_UTXO_LOVELACE = 2_000_000n;

/** Lovelace per ADA. */
export const LOVELACE_PER_ADA = 1_000_000n;

/** Protocol fee in basis points (2%) — default for new pools. */
export const DEFAULT_PROTOCOL_FEE_BPS = 200n;

/**
 * LP token asset name "aLP" as raw bytes. The pool validator hard-codes
 * this in the LP mint check.
 */
export const LP_TOKEN_NAME: Uint8Array = new Uint8Array([0x61, 0x4c, 0x50]);

/** Partner share cap (bps of protocol fee). Pinned by validator at 2000. */
export const PARTNER_SHARE_CAP_BPS = 2_000n;
