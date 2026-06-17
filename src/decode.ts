// decodeChainError — translate a raw wallet / node / submit failure into a
// stable code + plain-English title + an actionable hint.
//
// Cardano's worst dev-UX is the opaque on-chain/wallet error: a partner sees
// `ValidationTagMismatch (IsValid True) (FailedUnexpectedly ...)` or
// `PPViewHashesDontMatch` and has no idea what to do. This maps the common
// ledger error tags + CIP-30 wallet shapes to something a human can act on.
// It is best-effort + forgiving: anything unrecognized falls back to UNKNOWN
// with the raw text preserved (never throws).

import type { AegisErrorCode } from './errors';

export interface DecodedChainError {
  /** Stable, machine-readable code (shared with AegisError). */
  code: AegisErrorCode;
  /** One line: what went wrong, in plain English. */
  title: string;
  /** One line: how to fix it. */
  hint: string;
  /** The original error, stringified + trimmed (for logs / display). */
  raw: string;
}

function stringify(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message || String(raw);
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const parts: string[] = [];
    if ('code' in o) parts.push(`code=${String(o.code)}`);
    if ('info' in o) parts.push(String(o.info));
    if ('message' in o) parts.push(String(o.message));
    const joined = parts.join(' ');
    if (joined.trim()) return joined;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

// CIP-30 numeric error codes (APIError / TxSignError). Refused-to-sign is the
// common one; the rest are wallet-side problems.
function cip30Code(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && 'code' in raw) {
    const c = (raw as { code: unknown }).code;
    if (typeof c === 'number') return c;
  }
  return null;
}

interface Rule {
  code: AegisErrorCode;
  // any of these substrings (case-insensitive) matches
  needles: string[];
  title: string;
  hint: string;
}

// Order matters: most specific first.
const RULES: Rule[] = [
  {
    code: 'SCRIPT_DATA_HASH_MISMATCH',
    needles: ['ppviewhashesdontmatch', 'scriptintegrityhash', 'scriptdatahash', 'script_data_hash'],
    title: 'The transaction’s script-data hash does not match its redeemers/datums.',
    hint: 'Submit the exact bytes the builder produced — do not let the wallet re-serialize the tx; if you spliced witnesses, preserve the original CBOR byte form. Also confirm the cost models / redeemer set are unchanged.',
  },
  {
    code: 'SCRIPT_FAILED',
    needles: ['failedunexpectedly', 'validationtagmismatch', 'plutusfailure', 'scriptexecutionerror', 'the machine terminated', 'cekevaluationfailure'],
    title: 'A Plutus validator ran and rejected the transaction (phase-2 failure).',
    hint: 'Re-check that the premium clears the on-chain floor, the pool can cover the coverage, and the policy is not in the dead-zone (use quoteForPosition / buildUnderwriteParts, which surface these up front). If you verified it insurable, confirm the SDK network constants match the deployed pool version.',
  },
  {
    code: 'VALUE_NOT_CONSERVED',
    needles: ['valuenotconserved', 'value not conserved'],
    title: 'Inputs do not equal outputs + fee + mint (value not conserved).',
    hint: 'Re-check the policy / pool-continuation / team output amounts and the treasury donation — every lovelace in must be accounted for out.',
  },
  {
    code: 'OUTSIDE_VALIDITY',
    needles: ['outsidevalidityinterval', 'outside validity'],
    title: 'The transaction’s validity window does not cover the current slot.',
    hint: 'Rebuild with a fresh validity range anchored to the current slot (the policy start_time must sit inside it). A stale build expires quickly.',
  },
  {
    code: 'INPUTS_SPENT',
    needles: ['badinputsutxo', 'already been spent', 'does not exist', 'utxo not found', 'inputsexhausted'],
    title: 'A required input was already spent or no longer exists.',
    hint: 'The singleton pool UTxO moves on every accepted tx — re-fetch the live pool UTxO (locate by the pool NFT) and rebuild the parts against it.',
  },
  {
    code: 'COLLATERAL_INSUFFICIENT',
    needles: ['insufficientcollateral', 'nocollateralinputs', 'collateralreturn', 'collateral'],
    title: 'The transaction lacks adequate Plutus collateral.',
    hint: 'Provide a pure-ADA collateral UTxO (~5 ADA) that carries no native tokens; token-bearing UTxOs cannot serve as collateral.',
  },
  {
    code: 'MISSING_SIGNATURE',
    needles: ['missingvkeywitness', 'missingrequiredsigners', 'missing signature', 'missingscriptwitness'],
    title: 'The transaction is missing a required signature/witness.',
    hint: 'Ensure the wallet signs every key-input it owns (and any required extra signer); splice the wallet witnesses into the witness set without dropping the script witnesses.',
  },
  {
    code: 'EX_UNITS_TOO_BIG',
    needles: ['exunitstoobig', 'maxtxexunits', 'execution units', 'ex units'],
    title: 'The declared script execution budget exceeds the protocol maximum.',
    hint: 'Lower the redeemer ex-units to the evaluated values (run a phase-2 evaluation), rather than shipping inflated seed budgets.',
  },
  {
    code: 'FEE_TOO_SMALL',
    needles: ['feetoosmall', 'minfeenotmet'],
    title: 'The transaction fee is below the minimum.',
    hint: 'Recompute the fee after finalizing inputs/outputs/ex-units and increase it to at least the required minimum.',
  },
  {
    code: 'MIN_UTXO',
    needles: ['outputtoosmall', 'min_utxo', 'minimumutxo', 'min ada', 'min-ada'],
    title: 'An output holds less ADA than the ledger minimum (min-UTxO).',
    hint: 'Raise that output’s lovelace to the min-UTxO (a token-bearing output needs more — e.g. the marker-bearing policy output must hold ≥ ~2 ADA of coverage).',
  },
];

/**
 * Decode a raw wallet/node/submit error. Never throws.
 */
export function decodeChainError(raw: unknown): DecodedChainError {
  const text = stringify(raw);
  const lower = text.toLowerCase();

  // CIP-30: a refused/declined signature is the most common wallet outcome.
  const code = cip30Code(raw);
  if (code === 2 || lower.includes('declined') || lower.includes('refused')) {
    return {
      code: 'USER_DECLINED',
      title: 'The user declined to sign the transaction in their wallet.',
      hint: 'No action needed — let the user retry when ready.',
      raw: text.slice(0, 2000),
    };
  }
  if (code === -1 || code === -2 || code === -3 || lower.includes('internalerror') || lower.includes('invalidrequest')) {
    return {
      code: 'WALLET_INTERNAL',
      title: 'The wallet reported an internal or invalid-request error.',
      hint: 'Reconnect the wallet and retry; if it persists, the unsigned tx may be malformed for that wallet — rebuild it.',
      raw: text.slice(0, 2000),
    };
  }

  for (const rule of RULES) {
    if (rule.needles.some((n) => lower.includes(n))) {
      return { code: rule.code, title: rule.title, hint: rule.hint, raw: text.slice(0, 2000) };
    }
  }

  return {
    code: 'UNKNOWN',
    title: 'Unrecognized wallet/node error.',
    hint: 'Inspect the raw error below; if it is a submit failure, a phase-2 evaluation of the tx usually pinpoints the failing script.',
    raw: text.slice(0, 2000),
  };
}
