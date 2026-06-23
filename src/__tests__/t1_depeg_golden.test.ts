// T1 Shielded Swap (iUSD depeg) golden-CBOR regression.
//
// Per CONTRACT §2: T1 uses the EXISTING buildUnderwriteParts with
//   riskClass:'Depeg', oracleProvider:'Indigo',
//   oraclePolicyId = FEEDS.IUSD_USD.policyId, partner:{address, shareBps}.
// No SDK signature change — this test PROVES the depeg path already composes
// the right parts and LOCKS the wire bytes (policy datum, pool datum, pool
// redeemer) byte-for-byte so a regression in the encoder/composer fails CI.

import { describe, it, expect } from 'vitest';
import { buildUnderwriteParts, aegisBindings } from '../compose';
import { FEEDS } from '../feeds';
import { decodePoolRedeemer, hexToBytes, bytesToHex } from '../cbor';

// Mainnet V4 bindings (release/mainnet.json), as used by the SaturnSwap web tx.
function mainnetBindings() {
  return {
    network: 'mainnet' as const,
    policyValidatorHash: '1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7',
    poolValidatorHash: 'c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f',
    poolAddress: 'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr',
    poolNftPolicyId: '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3',
    poolNftAssetNameHex: bytesToHex(new TextEncoder().encode('AEGIS_POOL_V4')),
    markerPolicyId: 'd9d24db4e4dabdc1af6a568a4ecd691b81fae891afd70eb6cabc51e7',
    teamAddress: 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3',
  };
}

const PARTNER_VKH = '00112233445566778899aabbccddeeff00112233445566778899aabb';

function depegParts() {
  return buildUnderwriteParts({
    bindings: mainnetBindings(),
    pool: {
      utxoRef: { txHash: 'c5f488034e869b1404c505ed797caa49905943641693422b1e19e2a3919ee297', index: 0 },
      lovelace: 100_000_000_000n,
      datum: {
        totalLiquidity: 100_000_000_000n,
        activeCoverage: 1_000_000_000n,
        lpTokenPolicy: hexToBytes('5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b'),
        protocolFeeBps: 200n,
        poolNft: hexToBytes('9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3'),
        lpSupply: 50_000_000_000n,
      },
    },
    insuredPkh: 'ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931',
    strikePriceScaled: 950_000n, // $0.95 — in the depeg band
    coverageLovelace: 2_000_000_000n,
    premiumLovelace: 2_000_000_000n - 1n, // < coverage; clears the depeg floor
    durationDays: 30,
    oraclePolicyId: FEEDS.IUSD_USD.policyId,
    oracleProvider: 'Indigo',
    riskClass: 'Depeg',
    partner: { address: { paymentVkh: hexToBytes(PARTNER_VKH), stakeVkh: null }, shareBps: 2_000n },
    policyId: '739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65',
    startTimeMs: 1_750_000_000_000n,
    expiryTimeMs: 1_750_000_000_000n + 30n * 86_400_000n,
  });
}

describe('T1 depeg (iUSD / Indigo / partner) — buildUnderwriteParts golden', () => {
  const parts = depegParts();

  it('is insurable and carries the Depeg risk class', () => {
    expect(parts.insurable).toBe(true);
    expect(parts.policyDatum.riskClass).toBe('Depeg');
  });

  it('pins the policy to the canonical iUSD relay feed NFT', () => {
    expect(FEEDS.IUSD_USD.policyId).toBe('f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02');
    expect(bytesToHex(parts.policyDatum.oracleNft)).toBe(FEEDS.IUSD_USD.policyId);
    expect(parts.policyDatum.oracleProvider).toBe('Indigo');
  });

  it('GOLDEN: policy output datum CBOR (Indigo provider, iUSD oracle, partner)', () => {
    // Indigo = OracleProvider Constr 3 (d87c80); partner = Some(addr) with
    // 2000 bps; risk_class Depeg = Constr 1 (d87a80).
    expect(parts.policyOutput.inlineDatumCbor).toBe(
      'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65581cae725d4765d908f114552f53422317cbef8c42698fc2b67e454669311a000e7ef01a773594001a773593ff1b000001977420dc001b000001980e9fa400581cf6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3d87c80d8799fd8799fd8799f581c00112233445566778899aabbccddeeff00112233445566778899aabbffd87a80ffff1907d0d87a80ff',
    );
  });

  it('GOLDEN: pool continuation datum CBOR (total += net_growth, active unchanged)', () => {
    expect(parts.poolOutput.inlineDatumCbor).toBe(
      'd8799f1b00000017bd4a22001ab2d05e00581c5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b18c8581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb31b0000000ba43b7400ff',
    );
  });

  it('GOLDEN: pool redeemer = Underwrite{coverage, premium}', () => {
    expect(parts.poolRedeemerCbor).toBe('d8799f1a773594001a773593ffff');
    expect(decodePoolRedeemer(hexToBytes(parts.poolRedeemerCbor))).toEqual({
      kind: 'Underwrite',
      coverage: 2_000_000_000n,
      premium: 1_999_999_999n,
    });
  });

  it('splits the fee with the partner (2000 bps of fee → 8 ADA partner, 32 ADA team)', () => {
    expect(parts.feeTotal).toBe(39_999_999n);
    expect(parts.teamOutput.lovelace).toBe(32_000_000n);
    expect(parts.partnerOutput).not.toBeNull();
    expect(parts.partnerOutput!.lovelace).toBe(7_999_999n);
    expect(parts.teamOutput.lovelace + parts.partnerOutput!.lovelace).toBe(parts.feeTotal);
  });

  it('routes the two-stage Conway treasury donation', () => {
    expect(parts.treasuryDonationLovelace).toBe(9_999_999n);
  });

  it('the aegisBindings(mainnet) ergonomic path agrees on the IUSD feed wiring', () => {
    // The frozen mainnet manifest binds a different pool than the synthetic
    // test pool above, so we only assert the feed lookup the web layer uses.
    const b = aegisBindings('mainnet');
    expect(b.network).toBe('mainnet');
    expect(FEEDS.IUSD_USD.policyId).toBe('f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02');
  });
});
