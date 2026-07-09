// Agent Vault (DeFAI Phase 3) — parts builders for the spend-bounded escrow.
//
// The SDK has no wallet, chain access, or tx framework: these functions produce
// the exact outputs / redeemer / datum a partner's own builder (Lucid, MeshJS,
// pycardano) splices into the transaction it is already building. Every value
// mirrors the on-chain agent_vault.ak recipe.
//
//   * buildFundVaultParts   — create a vault UTxO (owner deposits capital).
//   * nextVaultDatumForSpend — the continuation datum for an agent Spend, with
//                              the same per_tx / epoch caps the validator enforces
//                              (so a caller that composes a spend fails fast
//                              rather than emitting a tx phase-2 will reject).
//   * buildOwnerSweepParts  — the owner's unilateral reclaim (Sweep redeemer).

import { encodeAgentVaultDatum, encodeAgentVaultRedeemer, bytesToHex } from './cbor';
import { scriptEnterpriseAddress, type Network } from './address';
import { MIN_UTXO_LOVELACE } from './constants';
import type { AgentVaultDatum } from './types';
import { InputError } from './errors';

export interface FundVaultPartsParams {
  vaultScriptHash: Uint8Array;
  datum: AgentVaultDatum;
  fundLovelace: bigint;
  network: Network;
}

export interface VaultOutputPart {
  address: string;
  lovelace: bigint;
  /** Hex CBOR of the inline AgentVaultDatum. */
  inlineDatumCbor: string;
}

export interface FundVaultParts {
  vaultOutput: VaultOutputPart;
}

/** Build the output that creates (or tops up) a vault UTxO. */
export function buildFundVaultParts(params: FundVaultPartsParams): FundVaultParts {
  const { vaultScriptHash, datum, fundLovelace, network } = params;
  if (vaultScriptHash.length !== 28) {
    throw new InputError('INVALID_INPUT', 'vaultScriptHash must be 28 bytes');
  }
  if (fundLovelace < MIN_UTXO_LOVELACE) {
    throw new InputError(
      'POOL_MIN_UTXO',
      `fundLovelace ${fundLovelace} is below the min-utxo floor ${MIN_UTXO_LOVELACE}`,
    );
  }
  return {
    vaultOutput: {
      address: scriptEnterpriseAddress(bytesToHex(vaultScriptHash), network),
      lovelace: fundLovelace,
      inlineDatumCbor: bytesToHex(encodeAgentVaultDatum(datum)),
    },
  };
}

/**
 * The continuation datum for an agent Spend of `spent` lovelace at time
 * `nowMs`. Applies the SAME rolling-epoch accounting the validator enforces:
 * reset when `nowMs >= epoch_start + epoch_len`, else accumulate. Throws if the
 * spend would breach `per_tx_cap` or `epoch_cap`, so a composer never emits a
 * spend the on-chain validator will reject.
 */
export function nextVaultDatumForSpend(
  current: AgentVaultDatum,
  spent: bigint,
  nowMs: bigint,
): AgentVaultDatum {
  if (spent <= 0n) throw new InputError('INVALID_INPUT', 'spent must be positive');
  if (spent > current.perTxCap) {
    throw new InputError('INVALID_INPUT', `spent ${spent} exceeds per_tx_cap ${current.perTxCap}`);
  }
  const newEpoch = nowMs >= current.epochStart + current.epochLen;
  const epochStart = newEpoch ? nowMs : current.epochStart;
  const epochSpent = newEpoch ? spent : current.epochSpent + spent;
  if (epochSpent > current.epochCap) {
    throw new InputError(
      'INVALID_INPUT',
      `epoch spend ${epochSpent} would exceed epoch_cap ${current.epochCap}`,
    );
  }
  return { ...current, epochStart, epochSpent };
}

export interface OwnerSweepPartsParams {
  vaultUtxo: { txHash: string; index: number; lovelace: bigint };
  datum: AgentVaultDatum;
  vaultScriptHash: Uint8Array;
}

export interface OwnerSweepParts {
  vaultInput: { txHash: string; index: number; lovelace: bigint };
  /** Hex CBOR of the Sweep redeemer. */
  redeemerCbor: string;
  /** The owner PKH (hex) that must sign the sweep. */
  requiredSigner: string;
}

/** Build the input-spend parts for the owner's unilateral vault sweep. */
export function buildOwnerSweepParts(params: OwnerSweepPartsParams): OwnerSweepParts {
  const { vaultUtxo, datum, vaultScriptHash } = params;
  if (vaultScriptHash.length !== 28) {
    throw new InputError('INVALID_INPUT', 'vaultScriptHash must be 28 bytes');
  }
  return {
    vaultInput: vaultUtxo,
    redeemerCbor: bytesToHex(encodeAgentVaultRedeemer('Sweep')),
    requiredSigner: bytesToHex(datum.owner),
  };
}
