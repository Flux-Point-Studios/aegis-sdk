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
//   * Conway treasury_donation = 0 (DECOUPLED, Option C Phase 4): the pool
//     validator is rotated with treasury_share_bps = 0, so no per-underwrite
//     donation is owed and the parts carry NO Conway key-22 field — a V2
//     cardano-swaps fill can ride the same tx. The treasury's % is settled by
//     a periodic key-witnessed sweep (see treasury_sweep.ts).
//   * validity: start = now − margin, expiry = start + term
//
// Insurability + pool gates run first; an un-buildable policy THROWS a named
// reason rather than emitting parts that would silently fail phase-2 on chain.

import type { OracleProvider, PlutusAddress, PolicyDatum, PoolDatum, RiskClass } from './types';
import {
  encodePolicyDatum,
  encodePoolDatum,
  encodePoolRedeemer,
  encodeMarkerRedeemer,
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
import { MIN_UTXO_LOVELACE, MAX_COVERAGE_RATIO } from './constants';
import * as MAINNET_CONSTS from './constants.mainnet';
import * as PREPROD_CONSTS from './constants.preprod';

/** "AEGIS_POLICY" — the marker token asset name (12 bytes, ASCII). */
const MARKER_ASSET_NAME_HEX = '41454749535f504f4c494359';
/** Portfolio concentration cap: new_active_coverage * 3 ≤ new_total_liquidity. */
const COVERAGE_CAP_FACTOR = 3n;
const DEFAULT_START_MARGIN_MS = 120_000n;
const MS_PER_DAY = 86_400_000n;

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
  /** Pool validator reference-script UTxO (to attach as a read-only ref). */
  poolRefUtxo?: RefUtxo;
  /** Marker mint-policy reference-script UTxO. */
  markerRefUtxo?: RefUtxo;
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
    teamOutput: { address: bindings.teamAddress, lovelace: teamCut },
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
