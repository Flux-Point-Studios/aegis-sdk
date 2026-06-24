// PolicyDatum + PoolDatum CBOR conformance vs the on-chain Aiken truth source.
//
// V4 PolicyDatum has 14 positional fields (contracts/lib/aegis/types.ak):
//   01 policy_id           : ByteArray
//   02 insured             : VerificationKeyHash (28 bytes)
//   03 strike_price        : Int (1e6-scaled)
//   04 coverage_amount     : Int (lovelace)
//   05 premium_paid        : Int (lovelace)
//   06 start_time          : Int (POSIX ms)
//   07 expiry_time         : Int (POSIX ms)
//   08 oracle_nft          : ByteArray (28 bytes)
//   09 pool_script_hash    : ScriptHash (28 bytes)
//   10 pool_nft            : ByteArray (28 bytes)
//   11 oracle_provider     : OracleProvider (Charli3=0, Orcfax=1, AegisSelf=2, Indigo=3)
//   12 partner_address     : Option<Address> (Some=0/None=1)
//   13 partner_share_bps   : Int
//   14 risk_class          : RiskClass (Barrier=0, Depeg=1)   <-- V4 (absent in R17)

import { describe, it, expect } from 'vitest';
import {
  encodePolicyDatum,
  encodePoolDatum,
  encodeConstr,
  encodeFullAddress,
  bytesToHex,
  hexToBytes,
} from '../cbor';
import { scriptPayoutTarget } from '../address';
import type { PolicyDatum, PoolDatum, PlutusFullAddress } from '../types';

// GROUND TRUTH: the real mainnet V4 policy dd56e6df…#1 inline datum, fetched
// from-chain via Blockfrost. The SDK MUST encode byte-identical to this — it is
// not a self-derived pin, it is the exact bytes the live validator accepted.
// Trailing 4 constrs: d87b80 (AegisSelf) d87a80 (partner None) 00 (share) d87980 (Barrier).
const TRUTH_MAINNET_DD56E6DF =
  'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65' +
  '581cae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931' +
  '1a0007a1201a1901ac201a01312d001b0000019ed3420b2f1b0000019f019b472f' +
  '581c68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f' +
  '581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f' +
  '581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3' +
  'd87b80d87a8000d87980ff';

const TRUTH_POLICY_CHARLI3_SOLO =
  'd8799f42aabb581c001122334455667788990011223344556677889900112233445566' +
  '771a000557301b000000012a05f2001a05f5e1001b0000018bcfe568001b0000018bf3' +
  'f1ec00581c886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e581d' +
  'aabbccdd11223344556677889900112233445566778899001122334455581bdeadbeef' +
  '00112233445566778899aabbccddeeff00112233445566d87980d87a8000d87980ff';

const TRUTH_POLICY_AEGISSELF_SOLO =
  'd8799f42ccdd581c001122334455667788990011223344556677889900112233445566' +
  '771a000f42401b00000002540be4001a0bebc2001b0000018bcfe568001b0000018bf3' +
  'f1ec00581cd2f08410f9f999b2afff902ec4ef47cc7b1677709887d20e0f13938f581d' +
  'aabbccdd11223344556677889900112233445566778899001122334455581bdeadbeef' +
  '00112233445566778899aabbccddeeff00112233445566d87b80d87a8000d87980ff';

const TRUTH_POOL =
  'd8799f1b000000174876e8001b00000004a817c80042aabb18c842ccdd1b000000174876e800ff';

describe('PolicyDatum CBOR (V4, 14 fields)', () => {
  it('encodes byte-identical to the LIVE mainnet datum (dd56e6df Surf-event policy)', () => {
    const datum: PolicyDatum = {
      policyId: hexToBytes('739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65'),
      insured: hexToBytes('ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931'),
      strikePrice: 500_000n,
      coverageAmount: 419_540_000n,
      premiumPaid: 20_000_000n,
      startTime: 1_781_660_781_359n,
      expiryTime: 1_782_438_381_359n,
      oracleNft: hexToBytes('68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f'),
      poolScriptHash: hexToBytes('c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f'),
      poolNft: hexToBytes('9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3'),
      oracleProvider: 'AegisSelf',
      partnerAddress: null,
      partnerShareBps: 0n,
      riskClass: 'Barrier',
    };
    expect(bytesToHex(encodePolicyDatum(datum))).toBe(TRUTH_MAINNET_DD56E6DF);
  });

  it('encodes risk_class as the 14th field (Barrier=d87980, Depeg=d87a80)', () => {
    const base: PolicyDatum = {
      policyId: hexToBytes('aabb'),
      insured: hexToBytes('00112233445566778899001122334455667788990011223344556677'),
      strikePrice: 1_000_000n,
      coverageAmount: 1_000_000_000n,
      premiumPaid: 50_000_000n,
      startTime: 1_700_000_000_000n,
      expiryTime: 1_700_604_800_000n,
      oracleNft: hexToBytes('82a324a3de0be7bc9c4b8450db5350cf0479fa1393eb8eee2481c652'),
      poolScriptHash: hexToBytes('c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f'),
      poolNft: hexToBytes('9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3'),
      oracleProvider: 'AegisSelf',
      partnerAddress: null,
      partnerShareBps: 0n,
      riskClass: 'Barrier',
    };
    const barrier = bytesToHex(encodePolicyDatum({ ...base, riskClass: 'Barrier' }));
    const depeg = bytesToHex(encodePolicyDatum({ ...base, riskClass: 'Depeg' }));
    // The 14th field is the only difference, sitting just before the closing 'ff'.
    expect(barrier.endsWith('d87980ff')).toBe(true);
    expect(depeg.endsWith('d87a80ff')).toBe(true);
    expect(barrier.slice(0, -8)).toBe(depeg.slice(0, -8));
  });

  it('matches truth bytes (Charli3 provider, no partner, Barrier)', () => {
    const datum: PolicyDatum = {
      policyId: hexToBytes('aabb'),
      insured: hexToBytes('00112233445566778899001122334455667788990011223344556677'),
      strikePrice: 350_000n,
      coverageAmount: 5_000_000_000n,
      premiumPaid: 100_000_000n,
      startTime: 1_700_000_000_000n,
      expiryTime: 1_700_604_800_000n,
      oracleNft: hexToBytes('886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e'),
      poolScriptHash: hexToBytes('aabbccdd11223344556677889900112233445566778899001122334455'),
      poolNft: hexToBytes('deadbeef00112233445566778899aabbccddeeff00112233445566'),
      oracleProvider: 'Charli3',
      partnerAddress: null,
      partnerShareBps: 0n,
      riskClass: 'Barrier',
    };
    expect(bytesToHex(encodePolicyDatum(datum))).toBe(TRUTH_POLICY_CHARLI3_SOLO);
  });

  it('matches truth bytes (AegisSelf provider, no partner, Barrier)', () => {
    const datum: PolicyDatum = {
      policyId: hexToBytes('ccdd'),
      insured: hexToBytes('00112233445566778899001122334455667788990011223344556677'),
      strikePrice: 1_000_000n,
      coverageAmount: 10_000_000_000n,
      premiumPaid: 200_000_000n,
      startTime: 1_700_000_000_000n,
      expiryTime: 1_700_604_800_000n,
      oracleNft: hexToBytes('d2f08410f9f999b2afff902ec4ef47cc7b1677709887d20e0f13938f'),
      poolScriptHash: hexToBytes('aabbccdd11223344556677889900112233445566778899001122334455'),
      poolNft: hexToBytes('deadbeef00112233445566778899aabbccddeeff00112233445566'),
      oracleProvider: 'AegisSelf',
      partnerAddress: null,
      partnerShareBps: 0n,
      riskClass: 'Barrier',
    };
    expect(bytesToHex(encodePolicyDatum(datum))).toBe(TRUTH_POLICY_AEGISSELF_SOLO);
  });
});

describe('PoolDatum CBOR (6 fields)', () => {
  it('matches truth bytes', () => {
    const datum: PoolDatum = {
      totalLiquidity: 100_000_000_000n,
      activeCoverage: 20_000_000_000n,
      lpTokenPolicy: hexToBytes('aabb'),
      protocolFeeBps: 200n,
      poolNft: hexToBytes('ccdd'),
      lpSupply: 100_000_000_000n,
    };
    expect(bytesToHex(encodePoolDatum(datum))).toBe(TRUTH_POOL);
  });
});

describe('PolicyDatum optional payout field (15th, address-typed)', () => {
  const base: PolicyDatum = {
    policyId: hexToBytes('aabb'),
    insured: hexToBytes('00112233445566778899001122334455667788990011223344556677'),
    strikePrice: 350_000n,
    coverageAmount: 5_000_000_000n,
    premiumPaid: 100_000_000n,
    startTime: 1_700_000_000_000n,
    expiryTime: 1_700_604_800_000n,
    oracleNft: hexToBytes('886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e'),
    poolScriptHash: hexToBytes('aabbccdd11223344556677889900112233445566778899001122334455'),
    poolNft: hexToBytes('deadbeef00112233445566778899aabbccddeeff00112233445566'),
    oracleProvider: 'Charli3',
    partnerAddress: null,
    partnerShareBps: 0n,
    riskClass: 'Barrier',
  };
  const SCRIPT_HASH = 'da'.repeat(28); // 28-byte script hash
  const STAKE_KEY = 'bb'.repeat(28);

  it('omitting the payout field is byte-identical to the 14-field form', () => {
    expect(bytesToHex(encodePolicyDatum(base))).toBe(TRUTH_POLICY_CHARLI3_SOLO);
    // an explicit `undefined` is the same as omitting it.
    expect(bytesToHex(encodePolicyDatum({ ...base, payoutAddress: undefined }))).toBe(
      TRUTH_POLICY_CHARLI3_SOLO,
    );
  });

  it('payoutAddress=null appends Option::None (d87a80) as the 15th field', () => {
    const with15 = bytesToHex(encodePolicyDatum({ ...base, payoutAddress: null }));
    // 14-field bytes with the trailing array break replaced by None + break.
    expect(with15).toBe(TRUTH_POLICY_CHARLI3_SOLO.slice(0, -2) + 'd87a80' + 'ff');
  });

  it('a script payout target appends Some(<script address>)', () => {
    const target = scriptPayoutTarget(SCRIPT_HASH);
    const with15 = bytesToHex(encodePolicyDatum({ ...base, payoutAddress: target }));
    const someOption = bytesToHex(encodeConstr(0, [encodeFullAddress(target)]));
    expect(with15).toBe(TRUTH_POLICY_CHARLI3_SOLO.slice(0, -2) + someOption + 'ff');
    // Script payment credential = Aiken `Credential::Script` = Constr 1 [hash]
    // = CBOR tag 122 over an indefinite array (d87a9f … ff).
    expect(someOption).toContain('d87a9f581c' + SCRIPT_HASH + 'ff');
  });

  it('encodeFullAddress round-trips a base script address (script payment + key stake)', () => {
    const addr: PlutusFullAddress = {
      payment: { kind: 'script', hash: hexToBytes(SCRIPT_HASH) },
      stake: { kind: 'key', hash: hexToBytes(STAKE_KEY) },
    };
    const hex = bytesToHex(encodeFullAddress(addr));
    expect(hex.startsWith('d8799f')).toBe(true); // Address = Constr 0 [...]
    expect(hex).toContain('d87a9f581c' + SCRIPT_HASH + 'ff'); // payment = Script
    // stake = Some(Inline(VerificationKey[hash])) = Constr0[Constr0[Constr0[hash]]].
    expect(hex).toContain('d8799fd8799fd8799f581c' + STAKE_KEY);
  });
});
