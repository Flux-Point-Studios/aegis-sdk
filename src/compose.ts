// buildUnderwriteParts — compose a pool-funded Aegis Underwrite into a partner
// transaction. Zero runtime deps: the SDK does NOT build or balance the tx (it
// has no wallet, no chain access, no tx framework). It produces the exact
// outputs / mint / redeemer / datum / treasury-donation / validity a partner's
// own builder (MeshJS, Lucid, …) splices into the tx they are already building
// at loan/CDP setup — the "one-click add insurance" primitive.
//
// Every value mirrors the proven on-chain recipe (contracts/lib/aegis/pool.ak
// Underwrite + the api/policies.py builder that passes on mainnet):
//   * policy output = `coverage` lovelace + 1 marker, at the policy script addr
//     (the POOL funds the coverage — premium does NOT sit on the policy output)
//   * pool continuation = old + net_growth − coverage, pool NFT preserved,
//     PoolDatum: total += net_growth, active += coverage, rest unchanged
//   * team output = team_cut (floored, absorbs a sub-min-utxo partner cut)
//   * partner output only when partner_cut ≥ min-utxo
//   * marker mint = +1 AEGIS_POLICY with MintMarkers{count:1}
//   * Conway treasury_donation = 0 on THIS composed path (V7 conditional
//     donation): treasury_share_bps stays 2500 on-chain and a PRESENT key-22
//     is still enforced ≥ the cut — but the validator ACCEPTS an ABSENT one,
//     so the composer omits key-22 (a V2 cardano-swaps fill can ride the same
//     tx). The treasury's % is reconciled by a periodic key-witnessed sweep
//     (see treasury_sweep.ts) that draws it from the accrued team fees.
//   * validity: start = now − margin, expiry = start + term
//
// Insurability + pool gates run first; an un-buildable policy THROWS a named
// reason rather than emitting parts that would silently fail phase-2 on chain.

import type { OracleProvider, PlutusAddress, PlutusFullAddress, PolicyDatum, PoolDatum, RiskClass } from './types';
import {
  encodePolicyDatum,
  encodePoolDatum,
  encodePoolRedeemer,
  encodeMarkerRedeemer,
  encodeLPTokenRedeemer,
  hexToBytes,
  bytesToHex,
} from './cbor';
import { scriptEnterpriseAddress, keyAddress, type Network } from './address';
import { derivePolicyId } from './blake2b';
import {
  calculateFeeTotal,
  calculateNetPoolGrowth,
  calculateProtocolFeeSplit,
} from './fees';
import { quoteForPosition, type QuoteVerdict } from './quote';
import { InputError, InsurabilityError, PoolError, ChainError } from './errors';
import { MIN_UTXO_LOVELACE, MAX_COVERAGE_RATIO, LP_TOKEN_NAME } from './constants';
import * as MAINNET_CONSTS from './constants.mainnet';
import * as PREPROD_CONSTS from './constants.preprod';

/** "AEGIS_POLICY" — the marker token asset name (12 bytes, ASCII). */
const MARKER_ASSET_NAME_HEX = '41454749535f504f4c494359';
/** Portfolio concentration cap: new_active_coverage * 3 ≤ new_total_liquidity. */
const COVERAGE_CAP_FACTOR = 3n;
const DEFAULT_START_MARGIN_MS = 120_000n;
const MS_PER_DAY = 86_400_000n;
/** "aLP" — the LP token asset name (3 bytes, ASCII) hard-coded by the validator. */
const LP_ASSET_NAME_HEX = bytesToHex(LP_TOKEN_NAME);

/** Hex of an ASCII asset name (Cardano protocol asset names are ASCII). */
function asciiToHex(s: string): string {
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) throw new Error(`asset name must be ASCII (got char code ${code})`);
    hex += code.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Bindings — the static, per-network protocol constants the composer needs.
// ---------------------------------------------------------------------------

export interface RefUtxo {
  txHash: string;
  index: number;
}

export interface AegisBindings {
  network: Network;
  /** Policy validator hash (28 hex) — the policy output's script address. */
  policyValidatorHash: string;
  /** Pool validator hash (28 hex) — written into PolicyDatum.poolScriptHash. */
  poolValidatorHash: string;
  /** Pool validator bech32 address (the pool continuation output sits here). */
  poolAddress: string;
  /** Pool NFT policy id (28 hex). */
  poolNftPolicyId: string;
  /** Pool NFT asset name, HEX-encoded. */
  poolNftAssetNameHex: string;
  /** Policy marker mint policy id (28 hex). */
  markerPolicyId: string;
  /** Team/treasury fee recipient bech32 address. */
  teamAddress: string;
  /** Optional inline datum (hex CBOR) to attach to the team_cut output. Set to
   *  the accrual TreasuryDatum{-1,""} (hex `d8799f2040ff`) ONLY when
   *  `teamAddress` is the cMATRA staking_treasury SCRIPT address, so team_cut
   *  accrues directly to the conservation-protected treasury. Leave undefined
   *  for a normal key-address team wallet. */
  teamOutputInlineDatumCbor?: string;
  /** Pool validator reference-script UTxO (to attach as a read-only ref). */
  poolRefUtxo?: RefUtxo;
  /** Marker mint-policy reference-script UTxO. */
  markerRefUtxo?: RefUtxo;
  /** LP-token mint-policy reference-script UTxO (vault add/remove liquidity). */
  lpRefUtxo?: RefUtxo;
}

/**
 * Assemble bindings for a network from the frozen-manifest constants. This is
 * the ergonomic entry point: `buildUnderwriteParts({ bindings: aegisBindings('mainnet'), … })`.
 */
export function aegisBindings(network: Network): AegisBindings {
  const c = network === 'mainnet' ? MAINNET_CONSTS : PREPROD_CONSTS;
  return {
    network,
    policyValidatorHash: c.AEGIS_POLICY_VALIDATOR_HASH,
    poolValidatorHash: c.AEGIS_POOL_VALIDATOR_HASH,
    poolAddress: c.AEGIS_POOL_ADDRESS,
    poolNftPolicyId: c.AEGIS_POOL_NFT_POLICY_ID,
    poolNftAssetNameHex: asciiToHex(c.AEGIS_POOL_NFT_ASSET_NAME),
    markerPolicyId: c.AEGIS_POLICY_MARKER_HASH,
    teamAddress: c.AEGIS_TEAM_ADDRESS,
    poolRefUtxo: c.AEGIS_POOL_REF_TX
      ? { txHash: c.AEGIS_POOL_REF_TX, index: c.AEGIS_POOL_REF_IDX }
      : undefined,
    markerRefUtxo: c.AEGIS_MARKER_REF_TX
      ? { txHash: c.AEGIS_MARKER_REF_TX, index: c.AEGIS_MARKER_REF_IDX }
      : undefined,
    lpRefUtxo: c.AEGIS_LP_REF_TX
      ? { txHash: c.AEGIS_LP_REF_TX, index: c.AEGIS_LP_REF_IDX }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface LivePoolState {
  /** The pool UTxO to be spent (script input). */
  utxoRef: RefUtxo;
  /** Current pool UTxO lovelace value. */
  lovelace: bigint;
  /** Decoded current PoolDatum read from chain. */
  datum: PoolDatum;
}

export interface BuildUnderwritePartsParams {
  bindings: AegisBindings;
  pool: LivePoolState;
  /** Insured payment key hash (56 hex / 28 bytes). */
  insuredPkh: string;
  /** 1e6-scaled USD strike. */
  strikePriceScaled: bigint;
  /** 1e6-scaled USD spot — REQUIRED for Barrier (the floor pre-flight). */
  spotPriceScaled?: bigint;
  coverageLovelace: bigint;
  /** API-quoted premium (lovelace). */
  premiumLovelace: bigint;
  durationDays: number;
  /** Canonical oracle feed NFT policy id (28 hex). */
  oraclePolicyId: string;
  oracleProvider?: OracleProvider;
  riskClass?: RiskClass;
  partner?: { address: PlutusAddress; shareBps: bigint };
  /**
   * Optional payout target for the Claim coverage. When set (e.g. a
   * contract-controlled beneficiary built via `scriptPayoutTarget`), the
   * coverage is paid to this exact address at claim time and the policy datum
   * carries the extended 15th field. When omitted, the coverage pays the
   * insured's own key (the standard 14-field datum). Only set this against a
   * validator that expects the field.
   */
  payout?: PlutusFullAddress;
  /** Optional 28-byte policy id (hex or bytes); default = the canonical
   *  BLAKE2b-224 derivation (matches the Aegis claim indexer's key). */
  policyId?: string | Uint8Array;
  /** Wall-clock now (ms); default Date.now(). */
  nowMs?: number;
  /** Start safety margin into the past (ms); default 120_000. */
  startMarginMs?: number;
  /** Pin the policy start (ms) — overrides now − margin (for exact reproduction). */
  startTimeMs?: bigint;
  /** Pin the policy expiry (ms) — overrides start + term. */
  expiryTimeMs?: bigint;
  /** Optional trace hook — called with (event, data) at each composition step.
   *  Pass `(e, d) => console.debug('[aegis]', e, d)` for a debug log. */
  onTrace?: (event: string, data?: unknown) => void;
}

export interface MarkerAsset {
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
}

export interface PolicyOutputPart {
  address: string;
  lovelace: bigint;
  marker: MarkerAsset;
  inlineDatumCbor: string;
}

export interface PoolOutputPart {
  address: string;
  lovelace: bigint;
  poolNft: MarkerAsset;
  inlineDatumCbor: string;
}

export interface FeeOutputPart {
  address: string;
  lovelace: bigint;
  /** Optional inline datum (hex CBOR) attached to this fee output. Used to make
   *  team_cut accrue DIRECTLY to the cMATRA staking treasury: when the deployed
   *  pool `team_address` is the staking_treasury SCRIPT address, the team output
   *  MUST carry the accrual TreasuryDatum{epoch_index:-1, alloc_root:#""}
   *  (hex `d8799f2040ff`) so the keeper can sweep it. Omitted → no datum. */
  inlineDatumCbor?: string;
}

export interface MintPart {
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
  redeemerCbor: string;
}

export interface UnderwriteParts {
  policyOutput: PolicyOutputPart;
  poolOutput: PoolOutputPart;
  teamOutput: FeeOutputPart;
  partnerOutput: FeeOutputPart | null;
  mint: MintPart;
  poolRedeemerCbor: string;
  treasuryDonationLovelace: bigint;
  feeTotal: bigint;
  /** The pool UTxO to spend (script input). */
  poolInput: RefUtxo;
  /** Reference scripts to attach + whether an oracle ref input is required. */
  references: { poolValidator: RefUtxo | null; marker: RefUtxo | null; oracleRequired: boolean };
  validity: { startTimeMs: bigint; expiryTimeMs: bigint };
  insurable: boolean;
  reason: string | null;
  /** The typed PolicyDatum (for inspection / off-chain indexing). */
  policyDatum: PolicyDatum;
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export function buildUnderwriteParts(params: BuildUnderwritePartsParams): UnderwriteParts {
  const {
    bindings,
    pool,
    insuredPkh,
    strikePriceScaled,
    spotPriceScaled,
    coverageLovelace,
    premiumLovelace,
    durationDays,
    oraclePolicyId,
    partner,
  } = params;
  const provider: OracleProvider = params.oracleProvider ?? 'AegisSelf';
  const riskClass: RiskClass = params.riskClass ?? 'Barrier';

  const trace = params.onTrace ?? (() => {});

  if (!insuredPkh || insuredPkh.length !== 56) {
    throw new InputError('INVALID_INPUT', `insuredPkh must be 56 hex chars (28 bytes), got ${insuredPkh?.length ?? 0}`);
  }
  if (coverageLovelace < MIN_UTXO_LOVELACE) {
    throw new InsurabilityError('COVERAGE_BELOW_MIN', `coverage must be at least ${MIN_UTXO_LOVELACE} lovelace (min-utxo)`, {
      hint: `raise coverage to at least ${MIN_UTXO_LOVELACE} lovelace (a marker-bearing policy output cannot satisfy min-ada below that)`,
    });
  }
  if (durationDays < 1) throw new InputError('INVALID_INPUT', 'durationDays must be >= 1');

  // ── Gate 1: premium adequacy (pricing.ak is_premium_adequate): premium >=
  //    2 ADA minimum AND coverage <= premium * 50 (exact multiply-form). ─────
  if (premiumLovelace < MIN_UTXO_LOVELACE) {
    throw new InsurabilityError('PREMIUM_BELOW_MIN', `premium ${premiumLovelace} is below the ${MIN_UTXO_LOVELACE}-lovelace minimum`, {
      hint: `raise the premium to at least ${MIN_UTXO_LOVELACE} lovelace`,
    });
  }
  if (coverageLovelace > premiumLovelace * MAX_COVERAGE_RATIO) {
    throw new InsurabilityError('RATIO_EXCEEDED',
      `coverage/premium ratio exceeds the ${MAX_COVERAGE_RATIO}x cap (coverage ${coverageLovelace}, premium ${premiumLovelace})`,
      { hint: `raise the premium to at least coverage/${MAX_COVERAGE_RATIO} = ${coverageLovelace / MAX_COVERAGE_RATIO} lovelace` },
    );
  }

  // ── Gate 2: insurability + on-chain floor (verify-only). ─────────────────
  const verdict = quoteForPosition({
    riskClass,
    coverageLovelace,
    strikePriceScaled,
    spotPriceScaled,
    durationDays,
    premiumLovelace,
  });
  trace('insurability', verdict);
  if (!verdict.insurable) {
    throw new InsurabilityError(verdict.reasonCode ?? 'BELOW_FLOOR', `policy is not insurable: ${verdict.reason}`, {
      hint:
        verdict.reasonCode === 'BELOW_FLOOR'
          ? `raise the premium to at least ${verdict.floorLovelace} lovelace (the on-chain floor for this strike/term)`
          : undefined,
    });
  }

  // ── Fee + pool math (validator-exact). ───────────────────────────────────
  const feeBps = pool.datum.protocolFeeBps;
  const feeTotal = calculateFeeTotal(premiumLovelace, feeBps);
  const netGrowth = calculateNetPoolGrowth(premiumLovelace, feeBps);
  const { teamCut, partnerCut } = calculateProtocolFeeSplit(
    premiumLovelace,
    feeBps,
    partner ? partner.shareBps : 0n,
  );
  // CONDITIONAL DONATION (Option C): the composer is the V2-composable path, so
  // it OMITS the Conway key-22 donation (0n) — a key-22 in the body poisons a
  // same-tx PlutusV2 cardano-swaps fill and fails phase-2. treasury_share_bps is
  // still 2500 on-chain (the standalone API path donates + is enforced); the
  // composer's omitted cut is reconciled by the periodic key-witnessed sweep
  // (see treasury_sweep.ts).
  const treasuryDonation = 0n;

  const newTotal = pool.datum.totalLiquidity + netGrowth;
  const newActive = pool.datum.activeCoverage + coverageLovelace;
  const newPoolLovelace = pool.lovelace + netGrowth - coverageLovelace;

  // ── Gate 3: pool can cover (available liquidity >= coverage). ────────────
  const available = pool.datum.totalLiquidity - pool.datum.activeCoverage;
  if (coverageLovelace > available) {
    throw new PoolError('POOL_CANNOT_COVER',
      `pool cannot cover: available liquidity ${available} < coverage ${coverageLovelace}`,
      { hint: `lower the coverage to ≤ ${available} lovelace, or wait for the pool to gain liquidity` },
    );
  }
  // ── Gate 4: portfolio concentration cap (new_active*3 <= new_total). ─────
  if (newActive * COVERAGE_CAP_FACTOR > newTotal) {
    throw new PoolError('CONCENTRATION_CAP',
      `coverage concentration cap breached: new active coverage ${newActive} would exceed 1/3 of pool liquidity ${newTotal}`,
      { hint: `lower the coverage so (active + coverage) * 3 ≤ total liquidity (max ~${(newTotal / 3n) - pool.datum.activeCoverage} lovelace more coverage right now)` },
    );
  }
  if (newPoolLovelace < MIN_UTXO_LOVELACE) {
    throw new PoolError('POOL_MIN_UTXO', `pool continuation lovelace ${newPoolLovelace} would fall below min-utxo`);
  }
  trace('pool-math', { newTotal, newActive, newPoolLovelace, feeTotal, teamCut, partnerCut, treasuryDonation });

  // ── Timing. ──────────────────────────────────────────────────────────────
  const nowMs = BigInt(params.nowMs ?? Date.now());
  const margin = params.startMarginMs !== undefined ? BigInt(params.startMarginMs) : DEFAULT_START_MARGIN_MS;
  const startTime = params.startTimeMs ?? nowMs - margin;
  const expiryTime = params.expiryTimeMs ?? startTime + BigInt(durationDays) * MS_PER_DAY;
  if (expiryTime <= startTime) throw new InputError('INVALID_INPUT', 'expiry must be after start');

  // ── PolicyDatum (14 fields). poolScriptHash = POOL validator hash; poolNft
  //    copied from the consumed pool datum (validator binds the policy to it). ─
  // Default policy_id is the canonical BLAKE2b-224 derivation (byte-identical to
  // api/policies.py::_generate_policy_id over the consumed pool UTxO's
  // OutputReference), so the composed policy is found under the same key by the
  // Aegis claim indexer / /api/policies. The on-chain validator treats policy_id
  // as opaque bytes — an explicit override is accepted for exact reproduction.
  const policyIdBytes =
    params.policyId === undefined
      ? derivePolicyId({
          insuredPkh,
          strikePriceScaled,
          coverageLovelace,
          startTimeMs: startTime,
          expiryTimeMs: expiryTime,
          poolNft: pool.datum.poolNft,
          underwriteTxHash: pool.utxoRef.txHash,
          underwriteOutputIndex: pool.utxoRef.index,
        })
      : typeof params.policyId === 'string'
        ? hexToBytes(params.policyId)
        : params.policyId;

  const policyDatum: PolicyDatum = {
    policyId: policyIdBytes,
    insured: hexToBytes(insuredPkh),
    strikePrice: strikePriceScaled,
    coverageAmount: coverageLovelace,
    premiumPaid: premiumLovelace,
    startTime,
    expiryTime,
    oracleNft: hexToBytes(oraclePolicyId),
    poolScriptHash: hexToBytes(bindings.poolValidatorHash),
    poolNft: pool.datum.poolNft,
    oracleProvider: provider,
    partnerAddress: partner ? partner.address : null,
    partnerShareBps: partner ? partner.shareBps : 0n,
    riskClass,
    // Optional payout target — appended as the 15th datum field only when set;
    // omitted (undefined) leaves the standard 14-field datum unchanged.
    payoutAddress: params.payout,
  };

  const updatedPoolDatum: PoolDatum = {
    totalLiquidity: newTotal,
    activeCoverage: newActive,
    lpTokenPolicy: pool.datum.lpTokenPolicy,
    protocolFeeBps: pool.datum.protocolFeeBps,
    poolNft: pool.datum.poolNft,
    lpSupply: pool.datum.lpSupply,
  };

  const marker: MarkerAsset = {
    policyId: bindings.markerPolicyId,
    assetNameHex: MARKER_ASSET_NAME_HEX,
    quantity: 1n,
  };

  return {
    policyOutput: {
      address: scriptEnterpriseAddress(bindings.policyValidatorHash, bindings.network),
      lovelace: coverageLovelace,
      marker,
      inlineDatumCbor: bytesToHex(encodePolicyDatum(policyDatum)),
    },
    poolOutput: {
      address: bindings.poolAddress,
      lovelace: newPoolLovelace,
      poolNft: { policyId: bindings.poolNftPolicyId, assetNameHex: bindings.poolNftAssetNameHex, quantity: 1n },
      inlineDatumCbor: bytesToHex(encodePoolDatum(updatedPoolDatum)),
    },
    // `teamAddress` is the pool validator's compile-time `team_address`
    // parameter — the pool enforces team_cut lands here (a `list.any` with `>=`
    // that never inspects the datum), so the destination is set at DEPLOY (a pool
    // param), not redirected off-chain. To fund cMATRA real-yield staking, deploy
    // the pool with `team_address` = the staking_treasury SCRIPT address and set
    // `teamOutputInlineDatumCbor` to the accrual TreasuryDatum{-1,""}
    // (d8799f2040ff): team_cut then accrues DIRECTLY to the conservation-
    // protected treasury, swept each epoch. The datum is REQUIRED in that case
    // (a script output with no datum is unspendable). See
    // aegis incentives/CMATRA_STAKING_V0_SPEC.md §3.
    teamOutput: bindings.teamOutputInlineDatumCbor
      ? {
          address: bindings.teamAddress,
          lovelace: teamCut,
          inlineDatumCbor: bindings.teamOutputInlineDatumCbor,
        }
      : { address: bindings.teamAddress, lovelace: teamCut },
    partnerOutput:
      partner && partnerCut > 0n
        ? {
            address: keyAddress(partner.address.paymentVkh, partner.address.stakeVkh, bindings.network),
            lovelace: partnerCut,
          }
        : null,
    mint: {
      policyId: bindings.markerPolicyId,
      assetNameHex: MARKER_ASSET_NAME_HEX,
      quantity: 1n,
      redeemerCbor: bytesToHex(encodeMarkerRedeemer({ kind: 'MintMarkers', count: 1 })),
    },
    poolRedeemerCbor: bytesToHex(
      encodePoolRedeemer({ kind: 'Underwrite', coverage: coverageLovelace, premium: premiumLovelace }),
    ),
    treasuryDonationLovelace: treasuryDonation,
    feeTotal,
    poolInput: pool.utxoRef,
    references: {
      poolValidator: bindings.poolRefUtxo ?? null,
      marker: bindings.markerRefUtxo ?? null,
      oracleRequired: riskClass === 'Barrier',
    },
    validity: { startTimeMs: startTime, expiryTimeMs: expiryTime },
    insurable: true,
    reason: null,
    policyDatum,
  };
}

// ===========================================================================
// T2 Coverage Vault — AddLiquidity / RemoveLiquidity composers.
//
// Both mirror buildUnderwriteParts' structure: gates run FIRST and throw a
// named reason (InputError / PoolError) rather than emit parts that would
// fail phase-2 on chain, then exact tx parts are returned.
//
// The LP math is the validator-authoritative form from
// contracts/lib/aegis/pool.ak (calculate_lp_mint / calculate_withdrawal):
//   * AddLiquidity:    lp_minted = total==0 ? deposit : deposit*lp_supply/total
//                      (integer floor — slightly favours the pool)
//   * RemoveLiquidity: withdrawn = lp_burned*total/lp_supply
//                      (integer floor — slightly favours the pool)
// and the matching PoolDatum transitions verify_add_liquidity_datum /
// verify_remove_liquidity_datum enforce (active_coverage unchanged;
// lp_token_policy / protocol_fee_bps / pool_nft immutable). The LP token is
// (pool_datum.lp_token_policy, "aLP") — the policy id is read from the live
// pool datum (the validator authorises the mint against that exact field).
// ===========================================================================

/**
 * LP tokens minted for a deposit, validator-exact
 * (contracts/lib/aegis/pool.ak::calculate_lp_mint). First deposit into an
 * empty pool (total_liquidity == 0) bootstraps 1:1; otherwise proportional
 * with integer-floor division (favours the pool — never over-mints).
 */
export function calculateLpMint(
  deposit: bigint,
  totalLiquidity: bigint,
  lpSupply: bigint,
): bigint {
  if (totalLiquidity === 0n) return deposit;
  return (deposit * lpSupply) / totalLiquidity;
}

/**
 * ADA returned for burning LP tokens, validator-exact
 * (contracts/lib/aegis/pool.ak::calculate_withdrawal):
 *   withdrawn = lp_burned * total_liquidity / lp_supply  (integer floor).
 * The validator REQUIRES the RemoveLiquidity redeemer's `amount` to equal
 * this value exactly, so the composer computes it here and routes it as both
 * the returned ADA and the redeemer amount. Floors favour the pool.
 */
export function calculateWithdrawal(
  lpBurned: bigint,
  totalLiquidity: bigint,
  lpSupply: bigint,
): bigint {
  if (lpSupply === 0n) {
    throw new PoolError('INVALID_INPUT', 'cannot withdraw: pool lpSupply is zero');
  }
  return (lpBurned * totalLiquidity) / lpSupply;
}

// ---------------------------------------------------------------------------
// Vault inputs / outputs
// ---------------------------------------------------------------------------

export interface LpAsset {
  /** LP-token mint policy id (28 hex) — = pool datum's lpTokenPolicy. */
  policyId: string;
  /** LP-token asset name, HEX-encoded ("aLP" -> "614c50"). */
  assetNameHex: string;
  quantity: bigint;
}

export interface LpProviderOutputPart {
  /** bech32 key address the LP receipt / returned ADA is paid to. */
  address: string;
  lovelace: bigint;
  /** The LP token paid out (AddLiquidity only); null on RemoveLiquidity. */
  lpToken: LpAsset | null;
}

export interface LpMintPart {
  policyId: string;
  assetNameHex: string;
  /** Signed: +minted on AddLiquidity, −burned on RemoveLiquidity. */
  quantity: bigint;
  redeemerCbor: string;
}

export interface VaultReferences {
  poolValidator: RefUtxo | null;
  lpToken: RefUtxo | null;
}

export interface BuildAddLiquidityPartsParams {
  bindings: AegisBindings;
  pool: LivePoolState;
  /** LP receipt recipient payment key hash (56 hex / 28 bytes). */
  providerPkh: string;
  /** ADA deposited into the pool (lovelace). */
  depositLovelace: bigint;
  /** Optional stake key hash (56 hex) for the provider receipt base address. */
  providerStakePkh?: string;
  /**
   * [L4VA] Optional script hash (56 hex / 28 bytes). When set, the minted aLP is
   * delivered to this SCRIPT enterprise address instead of `providerPkh`'s key
   * address — so a fractionalization / underwriter vault can custody the
   * position. `providerPkh` is then unused for the recipient.
   */
  providerScriptHash?: string;
  /** Optional trace hook — called with (event, data) at each step. */
  onTrace?: (event: string, data?: unknown) => void;
}

export interface AddLiquidityParts {
  /** Pool continuation: value = old + deposit, NFT preserved, datum updated. */
  poolOutput: PoolOutputPart;
  /** LP receipt output: lpMinted aLP tokens to the provider. */
  providerOutput: LpProviderOutputPart;
  /** +lpMinted aLP MintLP of the pool's lpTokenPolicy. */
  mint: LpMintPart;
  /** AddLiquidity{amount: deposit}. */
  poolRedeemerCbor: string;
  /** MintLP. */
  lpRedeemerCbor: string;
  /** The pool UTxO to spend (script input). */
  poolInput: RefUtxo;
  references: VaultReferences;
  /** LP tokens minted for this deposit (validator-exact). */
  lpMinted: bigint;
  /** The typed PoolDatum written to the continuation (for inspection). */
  poolDatum: PoolDatum;
}

export interface BuildRemoveLiquidityPartsParams {
  bindings: AegisBindings;
  pool: LivePoolState;
  /** Returned-ADA recipient payment key hash (56 hex / 28 bytes). */
  providerPkh: string;
  /** aLP tokens burned (lovelace-denominated count). */
  lpTokensToBurn: bigint;
  /** Optional stake key hash (56 hex) for the provider return base address. */
  providerStakePkh?: string;
  /** Optional trace hook — called with (event, data) at each step. */
  onTrace?: (event: string, data?: unknown) => void;
}

export interface RemoveLiquidityParts {
  /** Pool continuation: value = old − withdrawn, NFT preserved, datum updated. */
  poolOutput: PoolOutputPart;
  /** Returned-ADA output: withdrawn lovelace to the provider (no LP token). */
  providerOutput: LpProviderOutputPart;
  /** −lpBurned aLP BurnLP of the pool's lpTokenPolicy. */
  mint: LpMintPart;
  /** RemoveLiquidity{amount: withdrawn}. */
  poolRedeemerCbor: string;
  /** BurnLP. */
  lpRedeemerCbor: string;
  /** The pool UTxO to spend (script input). */
  poolInput: RefUtxo;
  references: VaultReferences;
  /** ADA returned for the burned LP tokens (validator-exact). */
  withdrawnLovelace: bigint;
  /** The typed PoolDatum written to the continuation (for inspection). */
  poolDatum: PoolDatum;
}

// ---------------------------------------------------------------------------
// AddLiquidity composer
// ---------------------------------------------------------------------------

export function buildAddLiquidityParts(params: BuildAddLiquidityPartsParams): AddLiquidityParts {
  const { bindings, pool, providerPkh, depositLovelace } = params;
  const trace = params.onTrace ?? (() => {});

  if (!providerPkh || providerPkh.length !== 56) {
    throw new InputError('INVALID_INPUT', `providerPkh must be 56 hex chars (28 bytes), got ${providerPkh?.length ?? 0}`);
  }
  if (params.providerStakePkh !== undefined && params.providerStakePkh.length !== 56) {
    throw new InputError('INVALID_INPUT', `providerStakePkh must be 56 hex chars (28 bytes), got ${params.providerStakePkh.length}`);
  }
  // Validator: `amount_positive = amount > 0`.
  if (depositLovelace <= 0n) {
    throw new InputError('INVALID_INPUT', 'depositLovelace must be positive');
  }

  // LP minted, validator-exact.
  const { totalLiquidity, lpSupply } = pool.datum;
  const lpMinted = calculateLpMint(depositLovelace, totalLiquidity, lpSupply);

  // Validator: `lp_minted = mint_qty == lp_supply_delta && mint_qty > 0` — a
  // deposit that floors to zero LP cannot be built (it would mint 0, failing
  // the on-chain `mint_qty > 0` gate). Reject it here with an actionable hint.
  if (lpMinted <= 0n) {
    throw new PoolError('INVALID_INPUT',
      `deposit ${depositLovelace} is too small to mint any LP (floors to 0 at the current pool ratio)`,
      { hint: `raise the deposit to at least ceil(totalLiquidity/lpSupply) = ${lpSupply === 0n ? 1n : (totalLiquidity + lpSupply - 1n) / lpSupply} lovelace so it mints ≥ 1 LP` },
    );
  }

  const newPoolLovelace = pool.lovelace + depositLovelace;
  const newPoolDatum: PoolDatum = {
    totalLiquidity: totalLiquidity + depositLovelace,
    activeCoverage: pool.datum.activeCoverage,
    lpTokenPolicy: pool.datum.lpTokenPolicy,
    protocolFeeBps: pool.datum.protocolFeeBps,
    poolNft: pool.datum.poolNft,
    lpSupply: lpSupply + lpMinted,
  };
  trace('add-liquidity', { lpMinted, newPoolLovelace, newTotal: newPoolDatum.totalLiquidity, newLpSupply: newPoolDatum.lpSupply });

  // LP token policy id is read from the live pool datum — the validator
  // authorises the mint against `datum.lp_token_policy` exactly.
  const lpPolicyId = bytesToHex(pool.datum.lpTokenPolicy);

  return {
    poolOutput: {
      address: bindings.poolAddress,
      lovelace: newPoolLovelace,
      poolNft: { policyId: bindings.poolNftPolicyId, assetNameHex: bindings.poolNftAssetNameHex, quantity: 1n },
      inlineDatumCbor: bytesToHex(encodePoolDatum(newPoolDatum)),
    },
    providerOutput: {
      // [L4VA] Deliver the aLP to a SCRIPT (vault) address when providerScriptHash
      // is set, so a fractionalization vault can custody the underwriting position;
      // otherwise the depositor's own key address (the default).
      address: params.providerScriptHash !== undefined
        ? scriptEnterpriseAddress(params.providerScriptHash, bindings.network)
        : keyAddress(
            hexToBytes(providerPkh),
            params.providerStakePkh !== undefined ? hexToBytes(params.providerStakePkh) : null,
            bindings.network,
          ),
      lovelace: MIN_UTXO_LOVELACE,
      lpToken: { policyId: lpPolicyId, assetNameHex: LP_ASSET_NAME_HEX, quantity: lpMinted },
    },
    mint: {
      policyId: lpPolicyId,
      assetNameHex: LP_ASSET_NAME_HEX,
      quantity: lpMinted,
      redeemerCbor: bytesToHex(encodeLPTokenRedeemer({ kind: 'MintLP' })),
    },
    poolRedeemerCbor: bytesToHex(encodePoolRedeemer({ kind: 'AddLiquidity', amount: depositLovelace })),
    lpRedeemerCbor: bytesToHex(encodeLPTokenRedeemer({ kind: 'MintLP' })),
    poolInput: pool.utxoRef,
    references: {
      poolValidator: bindings.poolRefUtxo ?? null,
      lpToken: bindings.lpRefUtxo ?? null,
    },
    lpMinted,
    poolDatum: newPoolDatum,
  };
}

// ---------------------------------------------------------------------------
// RemoveLiquidity composer
// ---------------------------------------------------------------------------

export function buildRemoveLiquidityParts(params: BuildRemoveLiquidityPartsParams): RemoveLiquidityParts {
  const { bindings, pool, providerPkh, lpTokensToBurn } = params;
  const trace = params.onTrace ?? (() => {});

  if (!providerPkh || providerPkh.length !== 56) {
    throw new InputError('INVALID_INPUT', `providerPkh must be 56 hex chars (28 bytes), got ${providerPkh?.length ?? 0}`);
  }
  if (params.providerStakePkh !== undefined && params.providerStakePkh.length !== 56) {
    throw new InputError('INVALID_INPUT', `providerStakePkh must be 56 hex chars (28 bytes), got ${params.providerStakePkh.length}`);
  }
  if (lpTokensToBurn <= 0n) {
    throw new InputError('INVALID_INPUT', 'lpTokensToBurn must be positive');
  }
  const { totalLiquidity, activeCoverage, lpSupply } = pool.datum;
  if (lpTokensToBurn > lpSupply) {
    throw new PoolError('INVALID_INPUT',
      `lpTokensToBurn ${lpTokensToBurn} exceeds pool lpSupply ${lpSupply}`,
      { hint: `burn at most ${lpSupply} LP tokens` },
    );
  }

  // Withdrawn ADA, validator-exact. This is BOTH the returned-ADA amount AND
  // the RemoveLiquidity redeemer's `amount` (the validator requires they match).
  const withdrawn = calculateWithdrawal(lpTokensToBurn, totalLiquidity, lpSupply);

  // Validator: `amount_positive = amount > 0` — a burn flooring to 0 ADA is
  // un-buildable (the RemoveLiquidity branch requires a positive amount).
  if (withdrawn <= 0n) {
    throw new PoolError('INVALID_INPUT',
      `burning ${lpTokensToBurn} LP returns 0 ADA (floors to zero at the current pool ratio)`,
      { hint: `burn more LP tokens, or wait for the pool's per-LP value to rise` },
    );
  }

  // ── Solvency invariant (contracts/lib/aegis/pool.ak::can_withdraw):
  //    total_liquidity − withdrawn >= active_coverage. A withdrawal that would
  //    push active coverage above the remaining liquidity MUST be rejected.
  if (totalLiquidity - withdrawn < activeCoverage) {
    throw new PoolError('POOL_CANNOT_COVER',
      `withdrawal of ${withdrawn} would impair active coverage: remaining liquidity ${totalLiquidity - withdrawn} < active coverage ${activeCoverage}`,
      { hint: `withdraw at most ${totalLiquidity - activeCoverage} lovelace of value (burn fewer LP tokens) so coverage stays funded` },
    );
  }

  const newPoolLovelace = pool.lovelace - withdrawn;
  if (newPoolLovelace < MIN_UTXO_LOVELACE) {
    throw new PoolError('POOL_MIN_UTXO',
      `pool continuation lovelace ${newPoolLovelace} would fall below min-utxo ${MIN_UTXO_LOVELACE}`,
      { hint: 'burn fewer LP tokens so the pool keeps at least min-utxo lovelace' },
    );
  }

  const newPoolDatum: PoolDatum = {
    totalLiquidity: totalLiquidity - withdrawn,
    activeCoverage,
    lpTokenPolicy: pool.datum.lpTokenPolicy,
    protocolFeeBps: pool.datum.protocolFeeBps,
    poolNft: pool.datum.poolNft,
    lpSupply: lpSupply - lpTokensToBurn,
  };
  trace('remove-liquidity', { withdrawn, newPoolLovelace, newTotal: newPoolDatum.totalLiquidity, newLpSupply: newPoolDatum.lpSupply });

  const lpPolicyId = bytesToHex(pool.datum.lpTokenPolicy);

  return {
    poolOutput: {
      address: bindings.poolAddress,
      lovelace: newPoolLovelace,
      poolNft: { policyId: bindings.poolNftPolicyId, assetNameHex: bindings.poolNftAssetNameHex, quantity: 1n },
      inlineDatumCbor: bytesToHex(encodePoolDatum(newPoolDatum)),
    },
    providerOutput: {
      address: keyAddress(
        hexToBytes(providerPkh),
        params.providerStakePkh !== undefined ? hexToBytes(params.providerStakePkh) : null,
        bindings.network,
      ),
      lovelace: withdrawn,
      lpToken: null,
    },
    mint: {
      policyId: lpPolicyId,
      assetNameHex: LP_ASSET_NAME_HEX,
      quantity: -lpTokensToBurn,
      redeemerCbor: bytesToHex(encodeLPTokenRedeemer({ kind: 'BurnLP' })),
    },
    poolRedeemerCbor: bytesToHex(encodePoolRedeemer({ kind: 'RemoveLiquidity', amount: withdrawn })),
    lpRedeemerCbor: bytesToHex(encodeLPTokenRedeemer({ kind: 'BurnLP' })),
    poolInput: pool.utxoRef,
    references: {
      poolValidator: bindings.poolRefUtxo ?? null,
      lpToken: bindings.lpRefUtxo ?? null,
    },
    withdrawnLovelace: withdrawn,
    poolDatum: newPoolDatum,
  };
}

// ---------------------------------------------------------------------------
// Preflight — run EVERY gate at once and return all results (vs buildUnderwrite
// Parts, which throws on the first blocker). Use it to show a partner exactly
// what's wrong, all at once, before they commit to building.
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  /** Short gate name (e.g. 'pool-can-cover'). */
  gate: string;
  ok: boolean;
  /** Human detail (the compared values). */
  detail: string;
}

export interface PreflightResult {
  /** True iff every gate passes (the policy is buildable). */
  ok: boolean;
  /** All gate results, in order. */
  checks: PreflightCheck[];
  /** Just the failing gates (empty when ok). */
  blockers: PreflightCheck[];
  /** The underlying insurability verdict (floor, dBps, …). */
  verdict: QuoteVerdict;
}

/**
 * Evaluate every Underwrite gate against live pool state without throwing.
 * Mirrors the gates buildUnderwriteParts enforces (premium adequacy, ratio,
 * insurability/floor, pool can-cover, concentration cap, pool min-utxo) — the
 * collect-all twin of the throwing path.
 */
export function preflightUnderwrite(params: {
  pool: LivePoolState;
  coverageLovelace: bigint;
  premiumLovelace: bigint;
  strikePriceScaled: bigint;
  spotPriceScaled?: bigint;
  durationDays: number;
  riskClass?: RiskClass;
}): PreflightResult {
  const riskClass: RiskClass = params.riskClass ?? 'Barrier';
  const { pool, coverageLovelace, premiumLovelace } = params;
  const checks: PreflightCheck[] = [];
  const add = (gate: string, ok: boolean, detail: string) => checks.push({ gate, ok, detail });

  add('coverage>=min-utxo', coverageLovelace >= MIN_UTXO_LOVELACE, `coverage ${coverageLovelace} vs min ${MIN_UTXO_LOVELACE}`);
  add('premium>=min', premiumLovelace >= MIN_UTXO_LOVELACE, `premium ${premiumLovelace} vs min ${MIN_UTXO_LOVELACE}`);
  add('ratio<=50x', coverageLovelace <= premiumLovelace * MAX_COVERAGE_RATIO, `coverage ${coverageLovelace} vs premium*${MAX_COVERAGE_RATIO} ${premiumLovelace * MAX_COVERAGE_RATIO}`);

  const verdict = quoteForPosition({
    riskClass,
    coverageLovelace,
    strikePriceScaled: params.strikePriceScaled,
    spotPriceScaled: params.spotPriceScaled,
    durationDays: params.durationDays,
    premiumLovelace,
  });
  add('insurable', verdict.insurable, verdict.insurable ? `clears floor ${verdict.floorLovelace}` : verdict.reason ?? 'not insurable');

  const feeBps = pool.datum.protocolFeeBps;
  const netGrowth = calculateNetPoolGrowth(premiumLovelace, feeBps);
  const newTotal = pool.datum.totalLiquidity + netGrowth;
  const newActive = pool.datum.activeCoverage + coverageLovelace;
  const newPoolLovelace = pool.lovelace + netGrowth - coverageLovelace;
  const available = pool.datum.totalLiquidity - pool.datum.activeCoverage;
  add('pool-can-cover', coverageLovelace <= available, `coverage ${coverageLovelace} vs available ${available}`);
  add('concentration-cap', newActive * COVERAGE_CAP_FACTOR <= newTotal, `(active+coverage)*3 ${newActive * COVERAGE_CAP_FACTOR} vs total ${newTotal}`);
  add('pool-out>=min-utxo', newPoolLovelace >= MIN_UTXO_LOVELACE, `pool continuation ${newPoolLovelace} vs min ${MIN_UTXO_LOVELACE}`);

  const blockers = checks.filter((c) => !c.ok);
  return { ok: blockers.length === 0, checks, blockers, verdict };
}

/**
 * Guard against a stale SDK manifest: assert the live pool UTxO's NFT matches
 * the network bindings. A mismatch means the pool was redeployed and the SDK
 * constants must be re-synced — far better caught here than as an opaque
 * on-chain reject.
 */
export function assertPoolMatchesManifest(livePoolDatum: PoolDatum, bindings: AegisBindings): void {
  const liveNft = bytesToHex(livePoolDatum.poolNft);
  if (liveNft !== bindings.poolNftPolicyId) {
    throw new ChainError('MANIFEST_MISMATCH',
      `live pool NFT ${liveNft} does not match the SDK manifest pool NFT ${bindings.poolNftPolicyId}`,
      { hint: 'the pool was redeployed — re-sync constants.<network>.ts from the current release/<network>.json (scripts/sync_sdk_constants_from_manifest.py)' },
    );
  }
}
