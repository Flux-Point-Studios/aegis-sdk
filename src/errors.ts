// Typed error hierarchy for the Aegis SDK.
//
// Every error the SDK throws is an `AegisError` with a stable, machine-readable
// `code` and (where useful) a human `hint` on how to fix it. Partners catch by
// `instanceof` (category) or by `code` (exact) — never by string-matching a
// message. The four categories:
//   - InputError       malformed/invalid arguments (programmer error)
//   - InsurabilityError a pricing/insurability gate rejected the policy
//   - PoolError        the live pool state can't accept this policy
//   - ChainError       a wallet/node/submit failure (often decoded from raw)

export type AegisErrorCode =
  // input
  | 'INVALID_INPUT'
  | 'MISSING_SPOT'
  // insurability gates
  | 'PREMIUM_BELOW_MIN'
  | 'COVERAGE_BELOW_MIN'
  | 'RATIO_EXCEEDED'
  | 'STRIKE_NOT_BELOW_SPOT'
  | 'BELOW_MIN_STRIKE_DISTANCE'
  | 'DEAD_ZONE'
  | 'BELOW_FLOOR'
  | 'PREMIUM_GE_COVERAGE'
  | 'DEPEG_STRIKE_OUT_OF_BAND'
  // pool state
  | 'POOL_CANNOT_COVER'
  | 'CONCENTRATION_CAP'
  | 'POOL_MIN_UTXO'
  | 'MANIFEST_MISMATCH'
  // chain / wallet (decoded)
  | 'SCRIPT_FAILED'
  | 'SCRIPT_DATA_HASH_MISMATCH'
  | 'VALUE_NOT_CONSERVED'
  | 'OUTSIDE_VALIDITY'
  | 'INPUTS_SPENT'
  | 'COLLATERAL_INSUFFICIENT'
  | 'MISSING_SIGNATURE'
  | 'EX_UNITS_TOO_BIG'
  | 'FEE_TOO_SMALL'
  | 'MIN_UTXO'
  | 'USER_DECLINED'
  | 'WALLET_INTERNAL'
  | 'UNKNOWN';

export type AegisErrorCategory = 'input' | 'insurability' | 'pool' | 'chain';

export interface AegisErrorOptions {
  /** A one-line, actionable suggestion for how to fix it. */
  hint?: string;
  /** The underlying error this wraps (raw chain/wallet error, etc.). */
  cause?: unknown;
}

/** Base class for every error the SDK throws. */
export class AegisError extends Error {
  readonly code: AegisErrorCode;
  readonly category: AegisErrorCategory;
  readonly hint?: string;
  // `cause` is standard on Error in modern runtimes; declare it for older libs.
  readonly cause?: unknown;

  constructor(
    category: AegisErrorCategory,
    code: AegisErrorCode,
    message: string,
    opts: AegisErrorOptions = {},
  ) {
    super(message);
    this.name = 'AegisError';
    this.category = category;
    this.code = code;
    this.hint = opts.hint;
    this.cause = opts.cause;
    // Restore the prototype chain (TS-targets-ES5 instanceof fix).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InputError extends AegisError {
  constructor(code: AegisErrorCode, message: string, opts?: AegisErrorOptions) {
    super('input', code, message, opts);
    this.name = 'InputError';
  }
}

export class InsurabilityError extends AegisError {
  constructor(code: AegisErrorCode, message: string, opts?: AegisErrorOptions) {
    super('insurability', code, message, opts);
    this.name = 'InsurabilityError';
  }
}

export class PoolError extends AegisError {
  constructor(code: AegisErrorCode, message: string, opts?: AegisErrorOptions) {
    super('pool', code, message, opts);
    this.name = 'PoolError';
  }
}

export class ChainError extends AegisError {
  constructor(code: AegisErrorCode, message: string, opts?: AegisErrorOptions) {
    super('chain', code, message, opts);
    this.name = 'ChainError';
  }
}
