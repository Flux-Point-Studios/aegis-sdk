// Agent Vault (DeFAI Phase 3) — datum codec + parts builders.
//
// The datum encoding is pinned byte-for-byte against a golden produced by
// pycardano's PlutusData (the same encoder the Aegis API uses), which in turn
// matches the on-chain Aiken positional decode in agent_vault.ak. Any drift in
// field order or CBOR shape fails here before it can mis-encode a real vault.

import { describe, it, expect } from 'vitest';
import {
  encodeAgentVaultDatum,
  decodeAgentVaultDatum,
  encodeAgentVaultRedeemer,
  hexToBytes,
  bytesToHex,
} from '../cbor';
import type { AgentVaultDatum } from '../types';
import {
  buildFundVaultParts,
  buildOwnerSweepParts,
  nextVaultDatumForSpend,
} from '../vault';

// Golden emitted by pycardano AgentVaultDatum(owner=aa*28, agent=bb*28,
// per_tx_cap=20e6, epoch_cap=50e6, epoch_len=604_800_000, epoch_start=1.7e12,
// epoch_spent=5e6, policy_script=cc*28, max_fee_leak=2e6, observer=dd*28).
const GOLDEN =
  'd8799f581caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa581cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1a01312d001a02faf0801a240c84001b0000018bcfe568001a004c4b40581ccccccccccccccccccccccccccccccccccccccccccccccccccccccccc1a001e8480581cddddddddddddddddddddddddddddddddddddddddddddddddddddddddff';

function sampleDatum(): AgentVaultDatum {
  return {
    owner: hexToBytes('aa'.repeat(28)),
    agent: hexToBytes('bb'.repeat(28)),
    perTxCap: 20_000_000n,
    epochCap: 50_000_000n,
    epochLen: 604_800_000n,
    epochStart: 1_700_000_000_000n,
    epochSpent: 5_000_000n,
    policyScript: hexToBytes('cc'.repeat(28)),
    maxFeeLeak: 2_000_000n,
    observerScriptHash: hexToBytes('dd'.repeat(28)),
  };
}

describe('AgentVaultDatum codec', () => {
  it('encodes byte-for-byte to the pycardano/Aiken golden', () => {
    expect(bytesToHex(encodeAgentVaultDatum(sampleDatum()))).toBe(GOLDEN);
  });

  it('round-trips through decode', () => {
    const d = decodeAgentVaultDatum(hexToBytes(GOLDEN));
    expect(bytesToHex(d.owner)).toBe('aa'.repeat(28));
    expect(bytesToHex(d.agent)).toBe('bb'.repeat(28));
    expect(d.perTxCap).toBe(20_000_000n);
    expect(d.epochCap).toBe(50_000_000n);
    expect(d.epochLen).toBe(604_800_000n);
    expect(d.epochStart).toBe(1_700_000_000_000n);
    expect(d.epochSpent).toBe(5_000_000n);
    expect(bytesToHex(d.policyScript)).toBe('cc'.repeat(28));
    expect(d.maxFeeLeak).toBe(2_000_000n);
    expect(bytesToHex(d.observerScriptHash)).toBe('dd'.repeat(28));
  });

  it('rejects a datum with the wrong constr id', () => {
    // Constr 1 (tag 122) instead of Constr 0.
    const bad = hexToBytes('d87a' + GOLDEN.slice(4));
    expect(() => decodeAgentVaultDatum(bad)).toThrow();
  });
});

describe('AgentVaultRedeemer codec', () => {
  it('encodes Spend as Constr 0 and Sweep as Constr 1', () => {
    expect(bytesToHex(encodeAgentVaultRedeemer('Spend'))).toBe('d87980');
    expect(bytesToHex(encodeAgentVaultRedeemer('Sweep'))).toBe('d87a80');
  });
});

describe('nextVaultDatumForSpend', () => {
  const base = sampleDatum();

  it('accumulates epoch_spent within the same window', () => {
    const now = base.epochStart + 1000n;
    const next = nextVaultDatumForSpend(base, 3_000_000n, now);
    expect(next.epochStart).toBe(base.epochStart);
    expect(next.epochSpent).toBe(base.epochSpent + 3_000_000n);
    // caps/identity preserved
    expect(next.perTxCap).toBe(base.perTxCap);
    expect(bytesToHex(next.owner)).toBe(bytesToHex(base.owner));
  });

  it('resets the accumulator when the window rolls', () => {
    const now = base.epochStart + base.epochLen + 1000n;
    const next = nextVaultDatumForSpend(base, 3_000_000n, now);
    expect(next.epochStart).toBe(now);
    expect(next.epochSpent).toBe(3_000_000n);
  });

  it('throws when the spend exceeds per_tx_cap', () => {
    const now = base.epochStart + 1000n;
    expect(() => nextVaultDatumForSpend(base, base.perTxCap + 1n, now)).toThrow(/per_tx/i);
  });

  it('throws when accumulated epoch spend exceeds epoch_cap', () => {
    const primed = { ...base, epochSpent: base.epochCap - 1_000_000n };
    const now = base.epochStart + 1000n;
    expect(() => nextVaultDatumForSpend(primed, 2_000_000n, now)).toThrow(/epoch/i);
  });
});

describe('buildFundVaultParts', () => {
  it('produces a vault output carrying the datum and the funded lovelace', () => {
    const d = sampleDatum();
    const parts = buildFundVaultParts({
      vaultScriptHash: hexToBytes('12'.repeat(28)),
      datum: d,
      fundLovelace: 100_000_000n,
      network: 'preprod',
    });
    expect(parts.vaultOutput.lovelace).toBe(100_000_000n);
    expect(parts.vaultOutput.inlineDatumCbor).toBe(bytesToHex(encodeAgentVaultDatum(d)));
    // vault output goes to the vault script address
    expect(parts.vaultOutput.address).toContain('addr');
  });

  it('rejects a fund below the min-utxo floor', () => {
    expect(() =>
      buildFundVaultParts({
        vaultScriptHash: hexToBytes('12'.repeat(28)),
        datum: sampleDatum(),
        fundLovelace: 500_000n,
        network: 'preprod',
      }),
    ).toThrow(/min/i);
  });
});

describe('buildOwnerSweepParts', () => {
  it('spends the vault UTxO with the Sweep redeemer and requires the owner signer', () => {
    const d = sampleDatum();
    const parts = buildOwnerSweepParts({
      vaultUtxo: { txHash: '00'.repeat(32), index: 0, lovelace: 100_000_000n },
      datum: d,
      vaultScriptHash: hexToBytes('12'.repeat(28)),
    });
    expect(parts.redeemerCbor).toBe('d87a80'); // Sweep
    expect(parts.requiredSigner).toBe('aa'.repeat(28)); // owner
    expect(parts.vaultInput.txHash).toBe('00'.repeat(32));
  });
});
