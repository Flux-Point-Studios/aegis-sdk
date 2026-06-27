// TypeScript projections of the Aiken on-chain datums and redeemers
// defined in contracts/lib/aegis/types.ak (R17 baseline).
//
// Authoritative truth source for CBOR field order and constr ids:
//   contracts/lib/aegis/types.ak                  (Aiken declarations)
//   api/policies.py                               (PyCardano dataclasses)
//
// The wire form is Plutus Data with indefinite-length Constr arrays for
// any variant carrying fields (`d8 79+i 9f ... ff`) and definite-length
// empty-array form for 0-field variants (`d8 79+i 80`). Do NOT canonicalize
// to definite-length on the fielded side — CIP-30 wallet round-trip
// must preserve byte identity (see reference_cip30_sign_submit.md).

// ---------------------------------------------------------------------------
// Address (Plutus Data shape, minimal — payment VKH + optional stake VKH)
// ---------------------------------------------------------------------------

/**
 * Minimal Plutus Data address mirror, used only for the partner field on
 * PolicyDatum. Mirrors the on-chain Aiken `Address` record:
 *
 *   Address { payment_credential, stake_credential }
 *
 * Only verification-key-hash credentials are supported off-chain (the
 * validator rejects script payment credentials on partner_address, see
 * api/policies.py:_validate_partner_address_payment_cred). Stake
 * credentials may be omitted (None) or be a 28-byte VKH wrapped in
 * Inline+VerificationKey.
 */
export interface PlutusAddress {
  /** 28-byte payment verification-key hash. */
  paymentVkh: Uint8Array;
  /** 28-byte stake verification-key hash, or `null` for no stake credential. */
  stakeVkh: Uint8Array | null;
}

/**
 * A Plutus credential — a verification-key hash (`'key'`) or a script hash
 * (`'script'`). Used by {@link PlutusFullAddress}, which (unlike the key-only
 * {@link PlutusAddress}) may carry a script payment credential.
 */
export interface PlutusCredential {
  kind: 'key' | 'script';
  /** 28-byte blake2b-224 hash. */
  hash: Uint8Array;
}

/**
 * A full Plutus Data address with arbitrary payment + optional inline stake
 * credentials, each a key or a script. Mirrors the on-chain Aiken `Address`
 * record in full, so a script payment credential (e.g. a contract-controlled
 * beneficiary) round-trips byte-for-byte.
 */
export interface PlutusFullAddress {
  payment: PlutusCredential;
  /** Inline stake credential, or `null` for an enterprise address. */
  stake: PlutusCredential | null;
}

// ---------------------------------------------------------------------------
// OracleProvider sum type
// ---------------------------------------------------------------------------

/**
 * On-chain Aiken `OracleProvider`. Constr ids:
 *   Charli3=0, Orcfax=1, AegisSelf=2, Indigo=3.
 */
export type OracleProvider = 'Charli3' | 'Orcfax' | 'AegisSelf' | 'Indigo';

/**
 * On-chain Aiken `RiskClass` (V4). Constr ids: Barrier=0, Depeg=1.
 * Selects which per-policy floor the Underwrite validator enforces
 * (Barrier = price-touch first-passage; Depeg = Poisson hazard).
 */
export type RiskClass = 'Barrier' | 'Depeg';

// ---------------------------------------------------------------------------
// PolicyDatum (V4, 14 positional fields)
// ---------------------------------------------------------------------------

/**
 * Inline datum locked at the policy script address.
 *
 * Field order is positional CBOR — DO NOT reorder; the validator's
 * `expect pdat: PolicyDatum` decoder matches by position.
 */
export interface PolicyDatum {
  /** Blake2b-224 of the policy terms (28 bytes), or any caller-chosen tag. */
  policyId: Uint8Array;
  /** Insured party verification-key hash (28 bytes). */
  insured: Uint8Array;
  /** ADA/USD strike price scaled by price_scale (1e6). */
  strikePrice: bigint;
  /** Maximum payout in lovelace. */
  coverageAmount: bigint;
  /** Premium paid in lovelace. */
  premiumPaid: bigint;
  /** Effective start time in POSIX milliseconds. */
  startTime: bigint;
  /** Expiration time in POSIX milliseconds. */
  expiryTime: bigint;
  /** Oracle NFT policy id (28 bytes); semantics depend on `oracleProvider`. */
  oracleNft: Uint8Array;
  /** Pool validator script hash (28 bytes). */
  poolScriptHash: Uint8Array;
  /** Canonical pool NFT policy id (28 bytes); pins the policy to one pool UTxO. */
  poolNft: Uint8Array;
  /** Which oracle backend authorises claims for this policy. */
  oracleProvider: OracleProvider;
  /** Optional partner address that receives `partnerShareBps` of the fee. */
  partnerAddress: PlutusAddress | null;
  /**
   * Partner share of the protocol fee, in basis points of the fee. The
   * validator caps this at `partner_share_cap_bps` (= 2000 bps of fee =
   * 0.4% of premium maximum). Must be 0 when `partnerAddress` is null.
   */
  partnerShareBps: bigint;
  /**
   * V4 risk class (14th positional field, appended after partner_share_bps —
   * contracts/lib/aegis/types.ak PolicyDatum field 14). Selects the per-policy
   * floor the validator enforces. A 13-field (R17) datum is rejected by the V4
   * decoder, so this field is mandatory.
   */
  riskClass: RiskClass;
  /**
   * Optional address-typed payout target for the Claim coverage (extended
   * 15th positional field).
   *
   * - **Omitted** (`undefined`) — the datum encodes to the V4 14-field wire form
   *   the deployed validator expects. This is the default; existing callers are
   *   unaffected.
   * - **Present** (an address, or explicit `null` to pay the insured's own key)
   *   — the datum encodes the extended 15-field form: the coverage is paid to
   *   this exact address, which may be a **script** address, so a
   *   contract-controlled beneficiary can receive the payout. Only valid against
   *   a validator that expects the field.
   */
  payoutAddress?: PlutusFullAddress | null;
  /**
   * Optional `receipt_commitment: Option<ByteArray>` — the 16th positional
   * field of the unified V5+P1 PolicyDatum (contracts/lib/aegis/types.ak,
   * AFTER payoutAddress).
   *
   * - **Omitted** (`undefined`) — the datum keeps the 14- or 15-field form
   *   (V4 / V5-payout). Existing callers are unaffected.
   * - **Present** — the datum encodes the full 16-field unified form (Aiken's
   *   record `expect` is STRICT on field count, so this is what the deployed
   *   V5+P1 pool/policy validators decode). `null` → `None` (Constr 1), keeping
   *   the policy on the plain-Claim path; a 32-byte commitment → `Some` (Constr
   *   0), binding it to ClaimWithReceipt (AI-cover / Materios). When set,
   *   `payoutAddress` (field 15) is emitted too (defaulting to `None`).
   */
  receiptCommitment?: Uint8Array | null;
}

// ---------------------------------------------------------------------------
// PoolDatum (R17, 6 fields — unchanged from R16)
// ---------------------------------------------------------------------------

export interface PoolDatum {
  totalLiquidity: bigint;
  activeCoverage: bigint;
  lpTokenPolicy: Uint8Array;
  protocolFeeBps: bigint;
  poolNft: Uint8Array;
  lpSupply: bigint;
}

// ---------------------------------------------------------------------------
// PolicyRedeemer  (R17: 5 zero-field variants)
// ---------------------------------------------------------------------------

/**
 * Aiken declaration order: Claim=0, BatchClaim=1, Expire=2, BatchExpire=3,
 * Cancel=4. No variant carries fields.
 */
export type PolicyRedeemer =
  | { kind: 'Claim' }
  | { kind: 'BatchClaim' }
  | { kind: 'Expire' }
  | { kind: 'BatchExpire' }
  | { kind: 'Cancel' };

// ---------------------------------------------------------------------------
// PoolRedeemer (R17)
// ---------------------------------------------------------------------------

/**
 * Aiken declaration order:
 *   0 Underwrite { coverage, premium }
 *   1 ProcessClaim { payout }
 *   2 AddLiquidity { amount }
 *   3 RemoveLiquidity { amount }
 *   4 BatchUnderwrite { total_coverage, total_premium }
 *   5 BatchExpireProcess { total_returned }
 *   6 AcceptCancellation
 *
 * R16 dropped `policy_script` from ProcessClaim and BatchExpireProcess
 * (replaced by branch-paired marker burns + script-address inference).
 * R17 (EXT-21) dropped `policy_script` from AcceptCancellation.
 */
export type PoolRedeemer =
  | { kind: 'Underwrite'; coverage: bigint; premium: bigint }
  | { kind: 'ProcessClaim'; payout: bigint }
  | { kind: 'AddLiquidity'; amount: bigint }
  | { kind: 'RemoveLiquidity'; amount: bigint }
  | {
      kind: 'BatchUnderwrite';
      totalCoverage: bigint;
      totalPremium: bigint;
    }
  | { kind: 'BatchExpireProcess'; totalReturned: bigint }
  | { kind: 'AcceptCancellation' };

// ---------------------------------------------------------------------------
// LPTokenRedeemer
// ---------------------------------------------------------------------------

export type LPTokenRedeemer = { kind: 'MintLP' } | { kind: 'BurnLP' };

// ---------------------------------------------------------------------------
// MarkerRedeemer  (R16+, 4-variant branch-pairing redeemer)
// ---------------------------------------------------------------------------

/**
 * Aiken `MarkerRedeemer` (contracts/lib/aegis/policy_marker.ak, declared
 * in contracts/lib/aegis/types.ak). Authority is split per lifecycle
 * branch so an unrelated policy.spend branch can never authorise a mint:
 *
 *   0 MintMarkers { count }         -- one marker per new policy
 *   1 BurnForClaim                  -- exactly one burn paired with Claim
 *   2 BurnForCancel                 -- exactly one burn paired with Cancel
 *   3 BurnForExpire { count }       -- N burns paired with BatchExpire
 */
export type MarkerRedeemer =
  | { kind: 'MintMarkers'; count: number }
  | { kind: 'BurnForClaim' }
  | { kind: 'BurnForCancel' }
  | { kind: 'BurnForExpire'; count: number };

// ---------------------------------------------------------------------------
// Charli3 oracle datum (read-side)
// ---------------------------------------------------------------------------

export interface OraclePriceData {
  price: bigint;
  timestamp: bigint;
  expiry: bigint;
}

export interface OracleDatum {
  priceData: OraclePriceData;
}

// ---------------------------------------------------------------------------
// SDK helper types (off-chain only)
// ---------------------------------------------------------------------------

export interface BuildPolicyParams {
  /** 56-char hex of the insured's payment vkh. */
  insuredPkh: string;
  /** Strike price in USD (e.g. 0.20). */
  strikePrice: number;
  /** Coverage amount in ADA. */
  coverageAda: number;
  /** Policy duration in days. */
  durationDays: number;
  /**
   * Oracle NFT policy id (hex). REQUIRED — AegisSelf has a per-asset NFT, so
   * there is no single default; pass the canonical feed NFT for this product.
   */
  oraclePolicyId?: string;
  /** Oracle backend (defaults to AegisSelf on mainnet). */
  oracleProvider?: OracleProvider;
  /** V4 risk class (defaults to 'Barrier'). */
  riskClass?: RiskClass;
}

export interface BuildPolicyOutputParams extends BuildPolicyParams {
  currentPrice: number;
  poolUtilization: number;
}

export interface PolicyOutput {
  address: string;
  amount: bigint;
  datum: Uint8Array;
  premiumBreakdown: PremiumResult;
}

export interface PremiumResult {
  premiumLovelace: bigint;
  baseRate: number;
  durationMult: number;
  utilFactor: number;
  strikeDistance: number;
}
