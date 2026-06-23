// T2 Coverage Vault composers — buildAddLiquidityParts / buildRemoveLiquidityParts.
//
// Tests assert the emitted parts mirror the validator-authoritative recipe
// (contracts/validators/pool.ak AddLiquidity / RemoveLiquidity + the LP math in
// contracts/lib/aegis/pool.ak calculate_lp_mint / calculate_withdrawal):
//   * pool continuation value = old ± deposit/withdrawn, NFT preserved
//   * PoolDatum: total ± amount, lp_supply ± lp; active_coverage + the three
//     immutable fields (lp_token_policy / protocol_fee_bps / pool_nft) unchanged
//   * provider output = aLP receipt (add) / returned ADA (remove)
//   * mint = +lpMinted MintLP (add) / −lpBurned BurnLP (remove) of lpTokenPolicy
//   * pool redeemer = AddLiquidity{deposit} / RemoveLiquidity{withdrawn}
//   * lp redeemer = MintLP / BurnLP
//   * solvency: a withdrawal that impairs active coverage THROWS PoolError
//
// Golden-CBOR vectors are byte-for-byte (literal hex) AND cross-checked against
// the encoder, so a wire-form regression fails the build.

import { describe, it, expect } from 'vitest';
import {
  buildAddLiquidityParts,
  buildRemoveLiquidityParts,
  calculateLpMint,
  calculateWithdrawal,
} from '../compose';
import {
  decodePoolRedeemer,
  decodeLPTokenRedeemer,
  encodePoolDatum,
  hexToBytes,
  bytesToHex,
} from '../cbor';
import { PoolError, InputError } from '../errors';
import type { PoolDatum } from '../types';

// ── V4 preprod bindings (release/preprod.json) ─────────────────────────────
const POOL_VALIDATOR_HASH = '681f71aca6fdb6a721896e095d1e13dd07d154a514b5d1dd854fa6a2';
const POOL_NFT_POLICY = 'da986312812002c71c24a04156c61e65b7e38bb2f81322618eff2725';
const LP_TOKEN_HASH = '732dcebec69abcd76a69863f9b0d31bc2745af3a6b8e6f3a6934ab3b';
const POOL_ADDR = 'addr_test1wp5p7udv5m7mdfep39hqjhg7z0ws0525552tt5was486dgsfkvwv8';
const POOL_NFT_NAME_HEX = bytesToHex(new TextEncoder().encode('AEGIS_POOL_12H_V1'));
const ALP_HEX = '614c50'; // "aLP"

// A provider payment key hash (28 bytes) for the LP receipt / ADA return.
const PROVIDER_PKH = '00112233445566778899aabbccddeeff00112233445566778899aabb';

function bindings(over: Record<string, unknown> = {}) {
  return {
    network: 'preprod' as const,
    policyValidatorHash: 'ff7469ffe5f3598289ce06c687942790d1a115e0c01d58ed3036ccc2',
    poolValidatorHash: POOL_VALIDATOR_HASH,
    poolAddress: POOL_ADDR,
    poolNftPolicyId: POOL_NFT_POLICY,
    poolNftAssetNameHex: POOL_NFT_NAME_HEX,
    markerPolicyId: 'b89348874aeddf60dd300200de714c104bd546e39f8a0f96a78ced17',
    teamAddress: 'addr_test1qrph8epfa8dg6wjwmls873g0xllyjnlt3hh08nv9kcrw9ln40ur83k9c87dpxuar3jucqrg0sc54zvzmf53pu6due2eqa5m8d2',
    poolRefUtxo: { txHash: '56d366b0ac7596edffe41300be174922284eb28ebb72144a120f8d146dc0e619', index: 0 },
    lpRefUtxo: { txHash: '77b51f0f64bd9acfd047ff898a06c2699dba3b0b77ac47af97fb2cd2dde8490f', index: 0 },
    ...over,
  };
}

function pool(over: Partial<PoolDatum> = {}, lovelaceOver?: bigint): {
  utxoRef: { txHash: string; index: number };
  lovelace: bigint;
  datum: PoolDatum;
} {
  const datum: PoolDatum = {
    totalLiquidity: 10_000_000_000n,
    activeCoverage: 1_000_000_000n,
    lpTokenPolicy: hexToBytes(LP_TOKEN_HASH),
    protocolFeeBps: 200n,
    poolNft: hexToBytes(POOL_NFT_POLICY),
    lpSupply: 5_000_000_000n,
    ...over,
  };
  return {
    utxoRef: { txHash: 'c5f488034e869b1404c505ed797caa49905943641693422b1e19e2a3919ee297', index: 0 },
    lovelace: lovelaceOver ?? datum.totalLiquidity,
    datum,
  };
}

// ===========================================================================
// AddLiquidity — value flow, datum update, mint, redeemers
// ===========================================================================

describe('buildAddLiquidityParts — proportional deposit value flow', () => {
  // Pool: 10B total, 5B lpSupply. Deposit 2B → lpMinted = 2B*5B/10B = 1B.
  const b = bindings();
  const parts = buildAddLiquidityParts({ bindings: b, pool: pool(), providerPkh: PROVIDER_PKH, depositLovelace: 2_000_000_000n });

  it('mints LP proportional to the deposit (validator-exact floor)', () => {
    expect(parts.lpMinted).toBe(1_000_000_000n);
  });

  it('pool continuation: lovelace = old + deposit, NFT preserved', () => {
    expect(parts.poolOutput.address).toBe(POOL_ADDR);
    expect(parts.poolOutput.lovelace).toBe(10_000_000_000n + 2_000_000_000n);
    expect(parts.poolOutput.poolNft).toEqual({ policyId: POOL_NFT_POLICY, assetNameHex: POOL_NFT_NAME_HEX, quantity: 1n });
  });

  it('pool datum: total += deposit, lpSupply += lpMinted; active + immutables unchanged', () => {
    const expected: PoolDatum = {
      totalLiquidity: 12_000_000_000n,
      activeCoverage: 1_000_000_000n,
      lpTokenPolicy: hexToBytes(LP_TOKEN_HASH),
      protocolFeeBps: 200n,
      poolNft: hexToBytes(POOL_NFT_POLICY),
      lpSupply: 6_000_000_000n,
    };
    expect(parts.poolOutput.inlineDatumCbor).toBe(bytesToHex(encodePoolDatum(expected)));
    expect(parts.poolDatum).toEqual(expected);
  });

  it('GOLDEN: poolOutput datum CBOR is byte-for-byte stable', () => {
    expect(parts.poolOutput.inlineDatumCbor).toBe(
      'd8799f1b00000002cb4178001a3b9aca00581c732dcebec69abcd76a69863f9b0d31bc2745af3a6b8e6f3a6934ab3b18c8581cda986312812002c71c24a04156c61e65b7e38bb2f81322618eff27251b0000000165a0bc00ff',
    );
  });

  it('GOLDEN: pool redeemer = AddLiquidity{amount: deposit}', () => {
    expect(parts.poolRedeemerCbor).toBe('d87b9f1a77359400ff');
    expect(decodePoolRedeemer(hexToBytes(parts.poolRedeemerCbor))).toEqual({ kind: 'AddLiquidity', amount: 2_000_000_000n });
  });

  it('GOLDEN: lp redeemer = MintLP', () => {
    expect(parts.lpRedeemerCbor).toBe('d87980');
    expect(decodeLPTokenRedeemer(hexToBytes(parts.lpRedeemerCbor))).toEqual({ kind: 'MintLP' });
  });

  it('mint = +lpMinted aLP of the pool datum lpTokenPolicy, with MintLP', () => {
    expect(parts.mint.policyId).toBe(LP_TOKEN_HASH);
    expect(parts.mint.assetNameHex).toBe(ALP_HEX);
    expect(parts.mint.quantity).toBe(1_000_000_000n);
    expect(decodeLPTokenRedeemer(hexToBytes(parts.mint.redeemerCbor))).toEqual({ kind: 'MintLP' });
  });

  it('provider output carries the aLP receipt + min-utxo lovelace', () => {
    expect(parts.providerOutput.lpToken).toEqual({ policyId: LP_TOKEN_HASH, assetNameHex: ALP_HEX, quantity: 1_000_000_000n });
    expect(parts.providerOutput.lovelace).toBe(2_000_000n);
    // bech32 key address (enterprise, no stake) for the provider pkh.
    expect(parts.providerOutput.address.startsWith('addr_test1v')).toBe(true);
  });

  it('references attach the pool + lp-token ref scripts', () => {
    expect(parts.references.poolValidator).toEqual(b.poolRefUtxo);
    expect(parts.references.lpToken).toEqual(b.lpRefUtxo);
    expect(parts.poolInput).toEqual(pool().utxoRef);
  });
});

describe('buildAddLiquidityParts — first deposit (empty pool bootstraps 1:1)', () => {
  const parts = buildAddLiquidityParts({
    bindings: bindings(),
    pool: pool({ totalLiquidity: 0n, activeCoverage: 0n, lpSupply: 0n }, 0n),
    providerPkh: PROVIDER_PKH,
    depositLovelace: 1_000_000_000n,
  });

  it('lpMinted == deposit (1:1 bootstrap)', () => {
    expect(parts.lpMinted).toBe(1_000_000_000n);
  });

  it('GOLDEN: first-deposit pool datum CBOR is byte-for-byte stable', () => {
    expect(parts.poolOutput.inlineDatumCbor).toBe(
      'd8799f1a3b9aca0000581c732dcebec69abcd76a69863f9b0d31bc2745af3a6b8e6f3a6934ab3b18c8581cda986312812002c71c24a04156c61e65b7e38bb2f81322618eff27251a3b9aca00ff',
    );
  });

  it('GOLDEN: first-deposit pool redeemer = AddLiquidity{1B}', () => {
    expect(parts.poolRedeemerCbor).toBe('d87b9f1a3b9aca00ff');
  });
});

describe('buildAddLiquidityParts — gates throw', () => {
  it('throws InputError on a non-positive deposit', () => {
    expect(() => buildAddLiquidityParts({ bindings: bindings(), pool: pool(), providerPkh: PROVIDER_PKH, depositLovelace: 0n })).toThrow(InputError);
  });

  it('throws InputError on a malformed providerPkh', () => {
    expect(() => buildAddLiquidityParts({ bindings: bindings(), pool: pool(), providerPkh: 'deadbeef', depositLovelace: 1_000_000_000n })).toThrow(/providerPkh/);
  });

  it('throws PoolError when a dust deposit floors to 0 LP (un-buildable on chain)', () => {
    // Pool: 10B total, 5B lpSupply → 1 lovelace * 5B / 10B = 0 LP.
    expect(() => buildAddLiquidityParts({ bindings: bindings(), pool: pool(), providerPkh: PROVIDER_PKH, depositLovelace: 1n })).toThrow(PoolError);
  });
});

// ===========================================================================
// RemoveLiquidity — value flow, datum update, burn, redeemers, solvency
// ===========================================================================

describe('buildRemoveLiquidityParts — proportional withdraw value flow', () => {
  // Pool: 10B total, 5B lpSupply. Burn 1B LP → withdrawn = 1B*10B/5B = 2B.
  const b = bindings();
  const parts = buildRemoveLiquidityParts({ bindings: b, pool: pool(), providerPkh: PROVIDER_PKH, lpTokensToBurn: 1_000_000_000n });

  it('returns ADA proportional to the LP burned (validator-exact floor)', () => {
    expect(parts.withdrawnLovelace).toBe(2_000_000_000n);
  });

  it('pool continuation: lovelace = old − withdrawn, NFT preserved', () => {
    expect(parts.poolOutput.lovelace).toBe(10_000_000_000n - 2_000_000_000n);
    expect(parts.poolOutput.poolNft).toEqual({ policyId: POOL_NFT_POLICY, assetNameHex: POOL_NFT_NAME_HEX, quantity: 1n });
  });

  it('pool datum: total −= withdrawn, lpSupply −= burned; active + immutables unchanged', () => {
    const expected: PoolDatum = {
      totalLiquidity: 8_000_000_000n,
      activeCoverage: 1_000_000_000n,
      lpTokenPolicy: hexToBytes(LP_TOKEN_HASH),
      protocolFeeBps: 200n,
      poolNft: hexToBytes(POOL_NFT_POLICY),
      lpSupply: 4_000_000_000n,
    };
    expect(parts.poolOutput.inlineDatumCbor).toBe(bytesToHex(encodePoolDatum(expected)));
    expect(parts.poolDatum).toEqual(expected);
  });

  it('GOLDEN: poolOutput datum CBOR is byte-for-byte stable', () => {
    expect(parts.poolOutput.inlineDatumCbor).toBe(
      'd8799f1b00000001dcd650001a3b9aca00581c732dcebec69abcd76a69863f9b0d31bc2745af3a6b8e6f3a6934ab3b18c8581cda986312812002c71c24a04156c61e65b7e38bb2f81322618eff27251aee6b2800ff',
    );
  });

  it('GOLDEN: pool redeemer = RemoveLiquidity{amount: withdrawn}', () => {
    expect(parts.poolRedeemerCbor).toBe('d87c9f1a77359400ff');
    expect(decodePoolRedeemer(hexToBytes(parts.poolRedeemerCbor))).toEqual({ kind: 'RemoveLiquidity', amount: 2_000_000_000n });
  });

  it('GOLDEN: lp redeemer = BurnLP', () => {
    expect(parts.lpRedeemerCbor).toBe('d87a80');
    expect(decodeLPTokenRedeemer(hexToBytes(parts.lpRedeemerCbor))).toEqual({ kind: 'BurnLP' });
  });

  it('mint = −lpBurned aLP of the pool datum lpTokenPolicy, with BurnLP', () => {
    expect(parts.mint.policyId).toBe(LP_TOKEN_HASH);
    expect(parts.mint.assetNameHex).toBe(ALP_HEX);
    expect(parts.mint.quantity).toBe(-1_000_000_000n);
    expect(decodeLPTokenRedeemer(hexToBytes(parts.mint.redeemerCbor))).toEqual({ kind: 'BurnLP' });
  });

  it('provider output returns ADA, no LP token', () => {
    expect(parts.providerOutput.lovelace).toBe(2_000_000_000n);
    expect(parts.providerOutput.lpToken).toBeNull();
  });

  it('redeemer amount equals the returned ADA (validator requires the match)', () => {
    const dec = decodePoolRedeemer(hexToBytes(parts.poolRedeemerCbor));
    expect(dec.kind).toBe('RemoveLiquidity');
    if (dec.kind === 'RemoveLiquidity') {
      expect(dec.amount).toBe(parts.providerOutput.lovelace);
      expect(dec.amount).toBe(parts.withdrawnLovelace);
    }
  });
});

describe('buildRemoveLiquidityParts — full withdraw drains the pool to its LPs', () => {
  // Burn ALL supply on a pool with no active coverage → withdraw all tracked
  // liquidity. The pool UTxO carries the NFT's min-utxo ON TOP of the tracked
  // liquidity (lovelace = totalLiquidity + min-utxo headroom), so the
  // continuation lands exactly at min-utxo after the full drain.
  const parts = buildRemoveLiquidityParts({
    bindings: bindings(),
    pool: pool(
      { totalLiquidity: 5_000_000_000n, activeCoverage: 0n, lpSupply: 5_000_000_000n },
      5_000_000_000n + 2_000_000n,
    ),
    providerPkh: PROVIDER_PKH,
    lpTokensToBurn: 5_000_000_000n,
  });

  it('returns the entire tracked liquidity (1:1 at supply == total)', () => {
    expect(parts.withdrawnLovelace).toBe(5_000_000_000n);
    expect(parts.poolDatum.totalLiquidity).toBe(0n);
    expect(parts.poolDatum.lpSupply).toBe(0n);
    expect(parts.poolOutput.lovelace).toBe(2_000_000n); // NFT min-utxo retained
  });
});

describe('buildRemoveLiquidityParts — SOLVENCY invariant (active_coverage <= total)', () => {
  it('throws PoolError when the withdrawal would impair active coverage', () => {
    // Pool: 10B total, 9.5B active, 5B lpSupply. Burn 1B LP → withdraw 2B.
    // remaining = 8B < active 9.5B → must reject.
    expect(() =>
      buildRemoveLiquidityParts({
        bindings: bindings(),
        pool: pool({ totalLiquidity: 10_000_000_000n, activeCoverage: 9_500_000_000n }),
        providerPkh: PROVIDER_PKH,
        lpTokensToBurn: 1_000_000_000n,
      }),
    ).toThrow(PoolError);
  });

  it('the error names the coverage-impairment reason (POOL_CANNOT_COVER)', () => {
    try {
      buildRemoveLiquidityParts({
        bindings: bindings(),
        pool: pool({ totalLiquidity: 10_000_000_000n, activeCoverage: 9_500_000_000n }),
        providerPkh: PROVIDER_PKH,
        lpTokensToBurn: 1_000_000_000n,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PoolError);
      expect((e as PoolError).code).toBe('POOL_CANNOT_COVER');
    }
  });

  it('allows a withdrawal exactly down to the active-coverage headroom', () => {
    // total 10B, active 8B, lpSupply 5B. Headroom = 2B value = 1B LP burned.
    const parts = buildRemoveLiquidityParts({
      bindings: bindings(),
      pool: pool({ totalLiquidity: 10_000_000_000n, activeCoverage: 8_000_000_000n }),
      providerPkh: PROVIDER_PKH,
      lpTokensToBurn: 1_000_000_000n,
    });
    expect(parts.withdrawnLovelace).toBe(2_000_000_000n);
    expect(parts.poolDatum.totalLiquidity).toBe(8_000_000_000n); // == active, solvent boundary
    expect(parts.poolDatum.activeCoverage).toBe(8_000_000_000n);
  });
});

describe('buildRemoveLiquidityParts — gates throw', () => {
  it('throws InputError on a non-positive burn', () => {
    expect(() => buildRemoveLiquidityParts({ bindings: bindings(), pool: pool(), providerPkh: PROVIDER_PKH, lpTokensToBurn: 0n })).toThrow(InputError);
  });

  it('throws PoolError when burning more than the pool lpSupply', () => {
    expect(() => buildRemoveLiquidityParts({ bindings: bindings(), pool: pool(), providerPkh: PROVIDER_PKH, lpTokensToBurn: 6_000_000_000n })).toThrow(PoolError);
  });

  it('throws PoolError when a burn floors to 0 ADA returned', () => {
    // total 3, lpSupply 5 → burn 1 LP * 3 / 5 = 0 ADA.
    expect(() =>
      buildRemoveLiquidityParts({
        bindings: bindings(),
        pool: pool({ totalLiquidity: 3n, activeCoverage: 0n, lpSupply: 5n }, 5_000_000n),
        providerPkh: PROVIDER_PKH,
        lpTokensToBurn: 1n,
      }),
    ).toThrow(PoolError);
  });

  it('throws PoolError when the pool continuation would fall below min-utxo', () => {
    // Withdraw almost everything: total 5M, active 0, lpSupply 5M, burn 4M LP
    // → withdraw 4M ADA, leaving 1M < 2M min-utxo.
    expect(() =>
      buildRemoveLiquidityParts({
        bindings: bindings(),
        pool: pool({ totalLiquidity: 5_000_000n, activeCoverage: 0n, lpSupply: 5_000_000n }, 5_000_000n),
        providerPkh: PROVIDER_PKH,
        lpTokensToBurn: 4_000_000n,
      }),
    ).toThrow(PoolError);
  });
});

// ===========================================================================
// LP math — table tests for the validator-exact helpers (rounding favours pool)
// ===========================================================================

describe('calculateLpMint — validator-exact (pool.ak::calculate_lp_mint)', () => {
  const cases: Array<[string, bigint, bigint, bigint, bigint]> = [
    // label, deposit, total, lpSupply, expected
    ['first depositor 1:1 (total==0)', 100_000_000n, 0n, 0n, 100_000_000n],
    ['proportional equal pool', 500_000_000n, 1_000_000_000n, 1_000_000_000n, 500_000_000n],
    ['proportional unequal pool (2:1)', 500_000_000n, 2_000_000_000n, 1_000_000_000n, 250_000_000n],
    ['truncation: 1*2/3 = 0', 1n, 3n, 2n, 0n],
    ['dust into deep pool floors to 0', 1n, 1_000_000_000n, 100_000_000n, 0n],
    ['rounding edge: 7*3/10 = 2 (floor, not 2.1)', 7n, 10n, 3n, 2n],
    ['rounding edge: 999*1000/1001 floors down', 999n, 1001n, 1000n, 998n],
  ];
  for (const [label, deposit, total, supply, expected] of cases) {
    it(label, () => {
      expect(calculateLpMint(deposit, total, supply)).toBe(expected);
    });
  }

  it('never over-mints: lpMinted/lpSupply <= deposit/total (floor favours pool)', () => {
    const deposit = 333n, total = 1000n, supply = 777n;
    const minted = calculateLpMint(deposit, total, supply); // 333*777/1000 = 258 (floor of 258.741)
    expect(minted).toBe(258n);
    // proportional claim of the minted LP must not exceed the deposit
    expect((minted * total) / supply).toBeLessThanOrEqual(deposit);
  });
});

describe('calculateWithdrawal — validator-exact (pool.ak::calculate_withdrawal)', () => {
  const cases: Array<[string, bigint, bigint, bigint, bigint]> = [
    ['half of a 2:1 pool', 250_000_000n, 2_000_000_000n, 1_000_000_000n, 500_000_000n],
    ['full supply returns all liquidity', 1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n],
    ['large amounts, no overflow', 50_000_000_000n, 100_000_000_000n, 100_000_000_000n, 50_000_000_000n],
    ['truncation: 1*3/5 = 0', 1n, 3n, 5n, 0n],
    ['rounding edge: 7*10/3 = 23 (floor of 23.33)', 7n, 10n, 3n, 23n],
    ['rounding edge: 1000*1001/999 floors down', 1000n, 1001n, 999n, 1002n],
  ];
  for (const [label, burned, total, supply, expected] of cases) {
    it(label, () => {
      expect(calculateWithdrawal(burned, total, supply)).toBe(expected);
    });
  }

  it('throws PoolError when lpSupply is zero (matches the validator `fail`)', () => {
    expect(() => calculateWithdrawal(1n, 1_000n, 0n)).toThrow(PoolError);
  });

  it('never over-returns: withdrawn <= lpBurned/lpSupply * total (floor favours pool)', () => {
    const burned = 333n, total = 1000n, supply = 777n;
    const withdrawn = calculateWithdrawal(burned, total, supply); // 333*1000/777 = 428 (floor of 428.57)
    expect(withdrawn).toBe(428n);
    expect(withdrawn * supply).toBeLessThanOrEqual(burned * total);
  });
});

// ===========================================================================
// Round-trip: deposit then withdraw the minted LP never returns more ADA than
// was deposited (the pool can only gain from rounding, never lose).
// ===========================================================================

describe('vault round-trip never over-pays the LP (rounding always favours pool)', () => {
  const samples: Array<[bigint, bigint, bigint]> = [
    [2_000_000_000n, 10_000_000_000n, 5_000_000_000n],
    [333_333_333n, 7_000_000_001n, 3_000_000_007n],
    [1_000_000_000n, 1_000_000_000n, 1_000_000_000n],
    [12_345_678n, 9_876_543_210n, 4_444_444_444n],
  ];
  for (const [deposit, total, supply] of samples) {
    it(`deposit ${deposit} into (total ${total}, supply ${supply})`, () => {
      const minted = calculateLpMint(deposit, total, supply);
      // Withdraw the freshly minted LP against the post-deposit pool state.
      const newTotal = total + deposit;
      const newSupply = supply + minted;
      const back = calculateWithdrawal(minted, newTotal, newSupply);
      expect(back).toBeLessThanOrEqual(deposit);
    });
  }
});

// ===========================================================================
// Immutable-field preservation (explicit) — the three on-chain immutables plus
// active_coverage (immutable on add AND remove).
// ===========================================================================

describe('vault composers preserve immutable PoolDatum fields', () => {
  const p = pool();

  it('AddLiquidity keeps active_coverage, lpTokenPolicy, protocolFeeBps, poolNft', () => {
    const parts = buildAddLiquidityParts({ bindings: bindings(), pool: p, providerPkh: PROVIDER_PKH, depositLovelace: 2_000_000_000n });
    expect(parts.poolDatum.activeCoverage).toBe(p.datum.activeCoverage);
    expect(bytesToHex(parts.poolDatum.lpTokenPolicy)).toBe(bytesToHex(p.datum.lpTokenPolicy));
    expect(parts.poolDatum.protocolFeeBps).toBe(p.datum.protocolFeeBps);
    expect(bytesToHex(parts.poolDatum.poolNft)).toBe(bytesToHex(p.datum.poolNft));
  });

  it('RemoveLiquidity keeps active_coverage, lpTokenPolicy, protocolFeeBps, poolNft', () => {
    const parts = buildRemoveLiquidityParts({ bindings: bindings(), pool: p, providerPkh: PROVIDER_PKH, lpTokensToBurn: 1_000_000_000n });
    expect(parts.poolDatum.activeCoverage).toBe(p.datum.activeCoverage);
    expect(bytesToHex(parts.poolDatum.lpTokenPolicy)).toBe(bytesToHex(p.datum.lpTokenPolicy));
    expect(parts.poolDatum.protocolFeeBps).toBe(p.datum.protocolFeeBps);
    expect(bytesToHex(parts.poolDatum.poolNft)).toBe(bytesToHex(p.datum.poolNft));
  });
});

// ===========================================================================
// Provider base-address (with stake credential) for the LP receipt.
// ===========================================================================

describe('vault provider output address honours an optional stake credential', () => {
  const STAKE_PKH = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544';
  it('AddLiquidity emits a base address (addr_test1q…) when a stake pkh is given', () => {
    const parts = buildAddLiquidityParts({ bindings: bindings(), pool: pool(), providerPkh: PROVIDER_PKH, depositLovelace: 2_000_000_000n, providerStakePkh: STAKE_PKH });
    expect(parts.providerOutput.address.startsWith('addr_test1q')).toBe(true);
  });
});
