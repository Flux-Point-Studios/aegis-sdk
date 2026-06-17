// AegisSDK — high-level facade over the R17 datums and the per-network
// frozen-manifest constants.

import { calculatePremium } from './pricing';
import { encodePolicyDatum, hexToBytes } from './cbor';
import * as preprod from './constants.preprod';
import { LOVELACE_PER_ADA, MIN_UTXO_LOVELACE, PRICE_SCALE } from './constants';
import type {
  BuildPolicyParams,
  BuildPolicyOutputParams,
  OracleProvider,
  PolicyDatum,
  PolicyOutput,
  PremiumResult,
} from './types';

type Network = 'preprod' | 'mainnet';

interface NetworkBindings {
  network: Network;
  poolAddress: string;
  poolNftPolicyId: string;
  policyValidatorHash: string;
  charli3AdaUsdNft: string;
}

function loadPreprod(): NetworkBindings {
  return {
    network: 'preprod',
    poolAddress: preprod.AEGIS_POOL_ADDRESS,
    poolNftPolicyId: preprod.AEGIS_POOL_NFT_POLICY_ID,
    policyValidatorHash: preprod.AEGIS_POLICY_VALIDATOR_HASH,
    charli3AdaUsdNft: preprod.AEGIS_CHARLI3_ADA_USD_NFT,
  };
}

declare const require: (id: string) => any;

function loadMainnet(): NetworkBindings {
  // Lazy require so a preprod-only build doesn't eagerly load the mainnet
  // constants module.
  const mn = require('./constants.mainnet');
  return {
    network: 'mainnet',
    poolAddress: mn.AEGIS_POOL_ADDRESS,
    poolNftPolicyId: mn.AEGIS_POOL_NFT_POLICY_ID,
    policyValidatorHash: mn.AEGIS_POLICY_VALIDATOR_HASH,
    charli3AdaUsdNft: mn.AEGIS_CHARLI3_ADA_USD_NFT,
  };
}

export class AegisSDK {
  private readonly bindings: NetworkBindings;

  constructor(network: Network = 'preprod') {
    this.bindings = network === 'preprod' ? loadPreprod() : loadMainnet();
  }

  /** Network this SDK instance is bound to. */
  get network(): Network {
    return this.bindings.network;
  }

  /** Bech32 address of the pool validator (canonical pool UTxO sits here). */
  get poolAddress(): string {
    return this.bindings.poolAddress;
  }

  /** Bech32 address of the policy validator script (derived from hash). */
  get policyValidatorHash(): string {
    return this.bindings.policyValidatorHash;
  }

  // -------------------------------------------------------------------------
  // Policy datum construction
  // -------------------------------------------------------------------------

  /**
   * Build a typed PolicyDatum from human-readable parameters.
   *
   * `premiumPaid` is left at 0n — callers should set it after pricing
   * (or use `buildPolicyOutput` which fills it in for you).
   */
  buildPolicyDatum(params: BuildPolicyParams): PolicyDatum {
    const {
      insuredPkh,
      strikePrice,
      coverageAda,
      durationDays,
      oraclePolicyId,
      oracleProvider,
    } = params;

    if (!insuredPkh || insuredPkh.length !== 56) {
      throw new Error(
        `insuredPkh must be 56 hex chars (28 bytes), got ${insuredPkh?.length ?? 0}.`,
      );
    }
    if (strikePrice <= 0) throw new Error('strikePrice must be positive');
    if (coverageAda < 5) throw new Error('coverageAda must be at least 5 ADA');
    if (durationDays < 1 || durationDays > 365) {
      throw new Error('durationDays must be between 1 and 365');
    }

    const strikePriceScaled = BigInt(
      Math.round(strikePrice * Number(PRICE_SCALE)),
    );
    const coverageLovelace = BigInt(
      Math.round(coverageAda * Number(LOVELACE_PER_ADA)),
    );

    const now = Date.now();
    const startTime = BigInt(now);
    const expiryTime = BigInt(now + durationDays * 24 * 60 * 60 * 1000);

    // Oracle backend + NFT. Mainnet default is AegisSelf; Charli3/Orcfax are
    // soft-disabled. AegisSelf has a per-asset NFT (spot ADA/BTC/ETH/USDC/USDT,
    // the iUSD relay, or a Surf event slot) so there is NO single default —
    // the canonical feed NFT must be supplied explicitly.
    const provider: OracleProvider = oracleProvider ?? 'AegisSelf';
    if (!oraclePolicyId) {
      throw new Error(
        `oraclePolicyId (canonical oracle NFT policy id) is required for oracleProvider="${provider}".`,
      );
    }
    const oracleNftHex: string = oraclePolicyId;

    const poolNftHex = this.bindings.poolNftPolicyId;
    if (!poolNftHex || poolNftHex.length !== 56) {
      throw new Error(
        'pool NFT policy id is empty or malformed in the network manifest. ' +
          'Re-run scripts/sync_sdk_constants_from_manifest.py against a frozen release/<network>.json.',
      );
    }

    const policyScriptHashHex = this.bindings.policyValidatorHash;
    if (!policyScriptHashHex || policyScriptHashHex.length !== 56) {
      throw new Error(
        'policy validator hash is empty in the network manifest. ' +
          'The applied script hash must be deployed before the SDK can build a policy datum.',
      );
    }

    // Deterministic-enough policy id for client-side use; on-chain only
    // requires a byte sequence so length and uniqueness are the concern.
    const policyIdInput = `${insuredPkh}:${strikePriceScaled}:${coverageLovelace}:${startTime}`;
    const policyIdBytes = deterministicHash(policyIdInput, 28);

    return {
      policyId: policyIdBytes,
      insured: hexToBytes(insuredPkh),
      strikePrice: strikePriceScaled,
      coverageAmount: coverageLovelace,
      premiumPaid: 0n,
      startTime,
      expiryTime,
      oracleNft: hexToBytes(oracleNftHex),
      poolScriptHash: hexToBytes(policyScriptHashHex),
      poolNft: hexToBytes(poolNftHex),
      oracleProvider: provider,
      partnerAddress: null,
      partnerShareBps: 0n,
      riskClass: params.riskClass ?? 'Barrier',
    };
  }

  encodePolicyDatum(datum: PolicyDatum): Uint8Array {
    return encodePolicyDatum(datum);
  }

  calculateLockAmount(premiumLovelace: bigint): bigint {
    return premiumLovelace > MIN_UTXO_LOVELACE
      ? premiumLovelace
      : MIN_UTXO_LOVELACE;
  }

  buildPolicyOutput(params: BuildPolicyOutputParams): PolicyOutput {
    const { currentPrice, poolUtilization, coverageAda, strikePrice, durationDays } =
      params;

    if (currentPrice <= 0) throw new Error('currentPrice must be positive');
    if (poolUtilization < 0 || poolUtilization > 1) {
      throw new Error('poolUtilization must be between 0 and 1');
    }
    if (strikePrice >= currentPrice) {
      throw new Error(
        `strikePrice (${strikePrice}) must be below currentPrice (${currentPrice}).`,
      );
    }

    const coverageLovelace = BigInt(
      Math.round(coverageAda * Number(LOVELACE_PER_ADA)),
    );
    const premium = calculatePremium({
      coverageLovelace,
      strikePrice,
      currentPrice,
      durationDays,
      poolUtilization,
    });

    const datum = this.buildPolicyDatum(params);
    datum.premiumPaid = premium.premiumLovelace;

    const cbor = this.encodePolicyDatum(datum);
    const lockAmount = this.calculateLockAmount(premium.premiumLovelace);

    return {
      address: this.poolAddress,
      amount: lockAmount,
      datum: cbor,
      premiumBreakdown: premium,
    };
  }

  previewPremium(params: {
    coverageAda: number;
    strikePrice: number;
    currentPrice: number;
    durationDays: number;
    poolUtilization: number;
  }): PremiumResult {
    const coverageLovelace = BigInt(
      Math.round(params.coverageAda * Number(LOVELACE_PER_ADA)),
    );
    return calculatePremium({
      coverageLovelace,
      strikePrice: params.strikePrice,
      currentPrice: params.currentPrice,
      durationDays: params.durationDays,
      poolUtilization: params.poolUtilization,
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic 28-byte tag from a string. Used as the client-side
 * `policyId`; on-chain only treats it as opaque bytes, so cryptographic
 * strength is not required here.
 */
function deterministicHash(input: string, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  for (let i = 0; i < length; i++) {
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    result[i] = (h >>> ((i % 4) * 8)) & 0xff;
  }
  return result;
}
