// buildUnderwriteParts — the pool-funded Underwrite composer a partner splices
// into their own tx. Tests assert the parts mirror the proven on-chain recipe:
// pool-funded value flow, exact PoolDatum update, fee split, marker mint,
// redeemer CBOR, treasury donation, validity, and the insurability gates.
//
// The headline test reconstructs the LIVE mainnet dd56e6df policy datum
// byte-for-byte from composer inputs — proving every field is wired correctly
// (notably poolScriptHash = POOL validator hash, oracle pin, provider, risk).

import { describe, it, expect } from 'vitest';
import { buildUnderwriteParts, aegisBindings } from '../compose';
import { derivePolicyId } from '../blake2b';
import { decodePoolRedeemer, decodeMarkerRedeemer, encodePoolDatum, decodePoolDatum, encodeConstr, encodeInt, encodeBytes, hexToBytes, bytesToHex } from '../cbor';
import type { PoolDatum } from '../types';

// ── V4 mainnet bindings (release/mainnet.json) ──────────────────────────────
const POOL_VALIDATOR_HASH = 'c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f';
const POLICY_VALIDATOR_HASH = '1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7';
const MARKER_HASH = 'd9d24db4e4dabdc1af6a568a4ecd691b81fae891afd70eb6cabc51e7';
const POOL_NFT_POLICY = '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3';
const LP_TOKEN_HASH = '5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b';
const POLICY_ADDR = 'addr1wyt80hz2qzysglhrzdk2004q7dhyn4nsw35gp86004rdldcnuy3ev';
const POOL_ADDR = 'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr';
const TEAM_ADDR = 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3';
const MARKER_NAME_HEX = '41454749535f504f4c494359'; // "AEGIS_POLICY"

function mainnetBindings() {
  return {
    network: 'mainnet' as const,
    policyValidatorHash: POLICY_VALIDATOR_HASH,
    poolValidatorHash: POOL_VALIDATOR_HASH,
    poolAddress: POOL_ADDR,
    poolNftPolicyId: POOL_NFT_POLICY,
    poolNftAssetNameHex: bytesToHex(new TextEncoder().encode('AEGIS_POOL_V4')),
    markerPolicyId: MARKER_HASH,
    teamAddress: TEAM_ADDR,
  };
}

function freshPool(over: Partial<PoolDatum> = {}): { utxoRef: { txHash: string; index: number }; lovelace: bigint; datum: PoolDatum } {
  return {
    utxoRef: { txHash: 'c5f488034e869b1404c505ed797caa49905943641693422b1e19e2a3919ee297', index: 0 },
    lovelace: 10_000_000_000n,
    datum: {
      totalLiquidity: 10_000_000_000n,
      activeCoverage: 1_000_000_000n,
      lpTokenPolicy: hexToBytes(LP_TOKEN_HASH),
      protocolFeeBps: 200n,
      poolNft: hexToBytes(POOL_NFT_POLICY),
      lpSupply: 5_000_000_000n,
      ...over,
    },
  };
}

const BARRIER = {
  insuredPkh: 'ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931',
  strikePriceScaled: 600_000n,
  spotPriceScaled: 800_000n, // d = 25%
  coverageLovelace: 200_000_000n,
  premiumLovelace: 80_196_647n,
  durationDays: 30,
  oraclePolicyId: '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f',
  riskClass: 'Barrier' as const,
};

describe('buildUnderwriteParts — pool-funded value flow', () => {
  const b = mainnetBindings();
  const parts = buildUnderwriteParts({ bindings: b, pool: freshPool(), ...BARRIER, nowMs: 1_750_000_000_000, startMarginMs: 120_000 });

  it('places the policy output at the policy script address with coverage + 1 marker', () => {
    expect(parts.policyOutput.address).toBe(POLICY_ADDR);
    expect(parts.policyOutput.lovelace).toBe(200_000_000n); // pool funds coverage
    expect(parts.policyOutput.marker).toEqual({ policyId: MARKER_HASH, assetNameHex: MARKER_NAME_HEX, quantity: 1n });
  });

  it('pool continuation: lovelace = old + net_growth − coverage, NFT preserved', () => {
    // net_growth = premium − fee_total = 80_196_647 − 2_000_000 = 78_196_647
    expect(parts.poolOutput.address).toBe(POOL_ADDR);
    expect(parts.poolOutput.lovelace).toBe(10_000_000_000n + 78_196_647n - 200_000_000n);
    expect(parts.poolOutput.poolNft).toEqual({ policyId: POOL_NFT_POLICY, assetNameHex: bytesToHex(new TextEncoder().encode('AEGIS_POOL_V4')), quantity: 1n });
  });

  it('pool datum update: total += net_growth, active += coverage, rest unchanged', () => {
    const expected: PoolDatum = {
      totalLiquidity: 10_000_000_000n + 78_196_647n,
      activeCoverage: 1_000_000_000n + 200_000_000n,
      lpTokenPolicy: hexToBytes(LP_TOKEN_HASH),
      protocolFeeBps: 200n,
      poolNft: hexToBytes(POOL_NFT_POLICY),
      lpSupply: 5_000_000_000n,
    };
    expect(parts.poolOutput.inlineDatumCbor).toBe(bytesToHex(encodePoolDatum(expected)));
  });

  it('team output = team_cut (2 ADA floor); no partner output', () => {
    expect(parts.teamOutput).toEqual({ address: TEAM_ADDR, lovelace: 2_000_000n });
    expect(parts.partnerOutput).toBeNull();
  });

  it('marker mint = +1 AEGIS_POLICY with MintMarkers{count:1}', () => {
    expect(parts.mint.policyId).toBe(MARKER_HASH);
    expect(parts.mint.assetNameHex).toBe(MARKER_NAME_HEX);
    expect(parts.mint.quantity).toBe(1n);
    expect(decodeMarkerRedeemer(hexToBytes(parts.mint.redeemerCbor))).toEqual({ kind: 'MintMarkers', count: 1 });
  });

  it('pool redeemer = Underwrite{coverage, premium}', () => {
    expect(decodePoolRedeemer(hexToBytes(parts.poolRedeemerCbor))).toEqual({
      kind: 'Underwrite',
      coverage: 200_000_000n,
      premium: 80_196_647n,
    });
  });

  it('treasury donation = two-stage cut of premium (Conway body field)', () => {
    expect(parts.treasuryDonationLovelace).toBe(400_983n);
  });

  it('validity: start = now − margin, expiry = start + days*86.4M', () => {
    expect(parts.validity.startTimeMs).toBe(1_750_000_000_000n - 120_000n);
    expect(parts.validity.expiryTimeMs).toBe(1_750_000_000_000n - 120_000n + 30n * 86_400_000n);
  });

  it('policyDatum.poolScriptHash is the POOL validator hash (matches live dd56e6df)', () => {
    expect(bytesToHex(parts.policyDatum.poolScriptHash)).toBe(POOL_VALIDATOR_HASH);
    expect(bytesToHex(parts.policyDatum.poolNft)).toBe(POOL_NFT_POLICY);
  });

  it('is insurable', () => {
    expect(parts.insurable).toBe(true);
  });
});

describe('buildUnderwriteParts — byte-exact reconstruction of the live dd56e6df datum', () => {
  // The frozen wire bytes of the mainnet Surf-event policy dd56e6df.
  const TRUTH =
    'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65581cae725d4765d908f114552f53422317cbef8c42698fc2b67e454669311a0007a1201a1901ac201a01312d001b0000019ed3420b2f1b0000019f019b472f581c68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3d87b80d87a8000d87980ff';

  it('composer produces the exact on-chain datum from real inputs + pinned times/id', () => {
    const parts = buildUnderwriteParts({
      bindings: mainnetBindings(),
      pool: freshPool(),
      insuredPkh: 'ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931',
      strikePriceScaled: 0x7a120n, // 500_000 ($0.50)
      spotPriceScaled: 1_000_000n, // d = 50% (insurable; spot not in the datum)
      coverageLovelace: 0x1901ac20n, // 419_540_000
      premiumLovelace: 0x1312d00n, // 20_000_000
      durationDays: 30,
      oraclePolicyId: '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f',
      oracleProvider: 'AegisSelf',
      riskClass: 'Barrier',
      policyId: '739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65',
      startTimeMs: 0x019ed3420b2fn,
      expiryTimeMs: 0x019f019b472fn,
    });
    expect(parts.policyOutput.inlineDatumCbor).toBe(TRUTH);
  });
});

describe('buildUnderwriteParts — default policy_id is the canonical BLAKE2b derivation', () => {
  const parts = buildUnderwriteParts({ bindings: mainnetBindings(), pool: freshPool(), ...BARRIER, nowMs: 1_750_000_000_000, startMarginMs: 120_000 });

  it('matches the authoritative api/policies.py::_generate_policy_id golden', () => {
    // golden = hashlib.blake2b(preimage, 28) over the consumed pool UTxO ref
    expect(bytesToHex(parts.policyDatum.policyId)).toBe('31d7d7a5333a9d4ec5e4f2eb560544b30e65e7bc69dad1add9bc0b9a');
  });

  it('equals derivePolicyId() over the same inputs (anchored to the pool input ref)', () => {
    const expected = derivePolicyId({
      insuredPkh: BARRIER.insuredPkh,
      strikePriceScaled: BARRIER.strikePriceScaled,
      coverageLovelace: BARRIER.coverageLovelace,
      startTimeMs: parts.validity.startTimeMs,
      expiryTimeMs: parts.validity.expiryTimeMs,
      poolNft: freshPool().datum.poolNft,
      underwriteTxHash: freshPool().utxoRef.txHash,
      underwriteOutputIndex: freshPool().utxoRef.index,
    });
    expect(bytesToHex(parts.policyDatum.policyId)).toBe(bytesToHex(expected));
  });

  it('an explicit override still wins over the default', () => {
    const override = buildUnderwriteParts({
      bindings: mainnetBindings(), pool: freshPool(), ...BARRIER,
      policyId: '739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65',
    });
    expect(bytesToHex(override.policyDatum.policyId)).toBe('739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65');
  });
});

describe('buildUnderwriteParts — insurability + pool gates throw on a bad build', () => {
  const b = mainnetBindings();

  it('throws when premium is below the on-chain floor', () => {
    expect(() =>
      buildUnderwriteParts({ bindings: b, pool: freshPool(), ...BARRIER, premiumLovelace: 5_000_000n }),
    ).toThrow(/floor/i);
  });

  it('throws when the coverage cap (active*3 ≤ total) would be breached', () => {
    // active already 3.2B; +200M*3 = 10.2B > total ~3.4B → cap breach
    const pool = freshPool({ totalLiquidity: 3_400_000_000n, activeCoverage: 3_200_000_000n });
    expect(() => buildUnderwriteParts({ bindings: b, pool, ...BARRIER })).toThrow(/cap|concentration/i);
  });

  it('throws when the pool cannot cover (available < coverage)', () => {
    // premium 200 ADA clears the d25/30d floor for 500 ADA cover, so the
    // can-cover gate (not the floor) is what fires.
    const pool = freshPool({ totalLiquidity: 1_100_000_000n, activeCoverage: 1_000_000_000n });
    expect(() =>
      buildUnderwriteParts({ bindings: b, pool, ...BARRIER, coverageLovelace: 500_000_000n, premiumLovelace: 200_000_000n }),
    ).toThrow(/cover|liquidity/i);
  });

  it('throws when coverage/premium exceeds the 50x ratio cap', () => {
    expect(() =>
      buildUnderwriteParts({ bindings: b, pool: freshPool(), ...BARRIER, coverageLovelace: 200_000_000n, premiumLovelace: 2_000_000n }),
    ).toThrow(/ratio|floor/i);
  });

  it('Barrier requires a spot price for the floor pre-flight', () => {
    const { spotPriceScaled, ...noSpot } = BARRIER;
    expect(() => buildUnderwriteParts({ bindings: b, pool: freshPool(), ...noSpot })).toThrow(/spot/i);
  });
});

describe('decodePoolDatum — reads the live pool UTxO datum the composer needs', () => {
  const datum: PoolDatum = {
    totalLiquidity: 10_000_000_000n,
    activeCoverage: 1_234_567n,
    lpTokenPolicy: hexToBytes('5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b'),
    protocolFeeBps: 200n,
    poolNft: hexToBytes('9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3'),
    lpSupply: 5_000_000_000n,
  };

  it('round-trips the SDK indefinite-array encoding', () => {
    expect(decodePoolDatum(encodePoolDatum(datum))).toEqual(datum);
  });

  it('also decodes the definite-length array form (some builders emit it)', () => {
    const definite = encodeConstr(0, []); // placeholder to access encoder shape
    void definite;
    // Hand-build a definite-length (major 4, len 6) Constr-0 PoolDatum.
    const tag = new Uint8Array([0xd8, 0x79]); // tag 121 = Constr 0
    const arrHeader = new Uint8Array([0x86]); // definite array, 6 items
    const fields = [
      encodeInt(datum.totalLiquidity),
      encodeInt(datum.activeCoverage),
      encodeBytes(datum.lpTokenPolicy),
      encodeInt(datum.protocolFeeBps),
      encodeBytes(datum.poolNft),
      encodeInt(datum.lpSupply),
    ];
    const total = tag.length + arrHeader.length + fields.reduce((s, f) => s + f.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of [tag, arrHeader, ...fields]) {
      buf.set(p, off);
      off += p.length;
    }
    expect(decodePoolDatum(buf)).toEqual(datum);
  });
});

describe('buildUnderwriteParts — partner fee + depeg routing', () => {
  const b = mainnetBindings();

  it('emits a partner output when the partner cut survives MIN_UTXO', () => {
    // 2000 ADA premium, 2000 bps share → partner_cut 8 ADA, team 32 ADA
    const partnerVkh = '00112233445566778899aabbccddeeff00112233445566778899aabb';
    const parts = buildUnderwriteParts({
      bindings: b,
      pool: freshPool({ totalLiquidity: 100_000_000_000n }),
      insuredPkh: BARRIER.insuredPkh,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      coverageLovelace: 2_000_000_000n,
      premiumLovelace: 2_000_000_000n - 1n, // < coverage; clears the d25/30d floor easily
      durationDays: 30,
      oraclePolicyId: BARRIER.oraclePolicyId,
      riskClass: 'Barrier',
      partner: { address: { paymentVkh: hexToBytes(partnerVkh), stakeVkh: null }, shareBps: 2_000n },
    });
    expect(parts.partnerOutput).not.toBeNull();
    expect(parts.teamOutput.lovelace + parts.partnerOutput!.lovelace).toBe(parts.feeTotal);
    expect(parts.partnerOutput!.lovelace).toBeGreaterThanOrEqual(2_000_000n);
  });

  it('routes a Depeg policy without a spot price', () => {
    // realistic depeg: premium clamped to the 20 ADA mainnet min keeps the
    // ratio (200/20 = 10x) within the on-chain 50x cap; clears the 78bps floor.
    const parts = buildUnderwriteParts({
      bindings: b,
      pool: freshPool(),
      insuredPkh: BARRIER.insuredPkh,
      strikePriceScaled: 950_000n, // $0.95 in band
      coverageLovelace: 200_000_000n,
      premiumLovelace: 20_000_000n,
      durationDays: 30,
      oraclePolicyId: 'a8231f0c10b514659fd590f6ee7420acf4e145cce36909a7f5fe1c5e',
      oracleProvider: 'AegisSelf',
      riskClass: 'Depeg',
    });
    expect(parts.insurable).toBe(true);
    expect(parts.policyDatum.riskClass).toBe('Depeg');
  });
});

// ── cMATRA staking: accrual datum on the team_cut output ────────────────────
describe('buildUnderwriteParts — staking accrual datum on team output', () => {
  // TreasuryDatum{ epoch_index: -1, alloc_root: #"" } (the accrual sentinel),
  // attached so team_cut accrues directly to the staking_treasury script.
  const ACCRUAL_DATUM = 'd8799f2040ff';

  it('attaches teamOutputInlineDatumCbor to teamOutput when set', () => {
    const bindings = { ...mainnetBindings(), teamOutputInlineDatumCbor: ACCRUAL_DATUM };
    const parts = buildUnderwriteParts({ bindings, pool: freshPool(), ...BARRIER, nowMs: 1_750_000_000_000, startMarginMs: 120_000 });
    expect(parts.teamOutput.address).toBe(TEAM_ADDR);
    expect(parts.teamOutput.inlineDatumCbor).toBe(ACCRUAL_DATUM);
  });

  it('omits the datum by default (key-address team wallet)', () => {
    const parts = buildUnderwriteParts({ bindings: mainnetBindings(), pool: freshPool(), ...BARRIER, nowMs: 1_750_000_000_000, startMarginMs: 120_000 });
    expect(parts.teamOutput.inlineDatumCbor).toBeUndefined();
  });
});
