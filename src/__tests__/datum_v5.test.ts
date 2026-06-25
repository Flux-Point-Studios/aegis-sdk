import { describe, it, expect } from 'vitest';
import {
  encodePolicyDatum,
  encodePolicyDatumV5,
  decodePolicyDatum,
  bytesToHex,
  hexToBytes,
} from '../cbor';
import type { PolicyDatum } from '../types';

// The live mainnet V4 policy dd56e6df…#1 inline datum (14 fields, ends in
// risk_class = Barrier `d87980`). Same ground-truth bytes pinned in datum.test.ts.
const TRUTH_MAINNET_DD56E6DF =
  'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65' +
  '581cae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931' +
  '1a0007a1201a1901ac201a01312d001b0000019ed3420b2f1b0000019f019b472f' +
  '581c68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f' +
  '581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f' +
  '581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3' +
  'd87b80d87a8000d87980ff';

// V5 form of the SAME policy with no AI binding: identical to V4 except a
// trailing `d87a80` (receipt_commitment = None, field index 14) before the
// outer break. This is the byte-level statement of "receipt is appended AFTER
// risk_class" — the whole point of the V4→V5 migration.
const TRUTH_V5_DD56E6DF_NONE =
  'd8799f581c739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65' +
  '581cae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931' +
  '1a0007a1201a1901ac201a01312d001b0000019ed3420b2f1b0000019f019b472f' +
  '581c68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f' +
  '581cc08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f' +
  '581c9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3' +
  'd87b80d87a8000d87980d87a80ff';

const dd56e6df = (): PolicyDatum => ({
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
});

// 32-byte commitment = blake2b-256(receipt_id ++ threshold_be8 ++ config_hash).
const COMMITMENT = hexToBytes(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
);

describe('PolicyDatum CBOR (V5, 15 fields — receipt_commitment)', () => {
  it('non-AI V5 datum is the V4 datum + trailing None (receipt at index 14)', () => {
    const v5 = bytesToHex(encodePolicyDatumV5({ ...dd56e6df(), receiptCommitment: null }));
    expect(v5).toBe(TRUTH_V5_DD56E6DF_NONE);
    // …and that is exactly V4 with `ff` -> `d87a80ff`, proving receipt is
    // appended AFTER risk_class rather than colliding with it.
    expect(v5).toBe(TRUTH_MAINNET_DD56E6DF.slice(0, -2) + 'd87a80ff');
  });

  it('omitting receiptCommitment is equivalent to None', () => {
    const omitted = bytesToHex(encodePolicyDatumV5(dd56e6df()));
    expect(omitted).toBe(TRUTH_V5_DD56E6DF_NONE);
  });

  it('V4 encoder is unchanged (still 14 fields, no receipt) for the same datum', () => {
    expect(bytesToHex(encodePolicyDatum(dd56e6df()))).toBe(TRUTH_MAINNET_DD56E6DF);
  });

  it('Some(commitment) sits at index 14, after risk_class (Barrier d87980)', () => {
    const hex = bytesToHex(
      encodePolicyDatumV5({ ...dd56e6df(), receiptCommitment: COMMITMENT }),
    );
    // …risk_class Barrier (d87980), then Some = d8799f 5820 <32B> ff, then outer break ff.
    expect(hex.endsWith('d87980d8799f5820' + bytesToHex(COMMITMENT) + 'ffff')).toBe(true);
  });

  it('Depeg risk_class + Some receipt keeps receipt strictly after risk_class', () => {
    const hex = bytesToHex(
      encodePolicyDatumV5({ ...dd56e6df(), riskClass: 'Depeg', receiptCommitment: COMMITMENT }),
    );
    // risk_class Depeg = d87a80, then Some(receipt), then outer break.
    expect(hex.endsWith('d87a80d8799f5820' + bytesToHex(COMMITMENT) + 'ffff')).toBe(true);
  });
});

describe('decodePolicyDatum round-trips V4 and V5', () => {
  it('decodes the legacy 14-field V4 datum with receiptCommitment = null', () => {
    const d = decodePolicyDatum(hexToBytes(TRUTH_MAINNET_DD56E6DF));
    expect(d.oracleProvider).toBe('AegisSelf');
    expect(d.partnerAddress).toBeNull();
    expect(d.partnerShareBps).toBe(0n);
    expect(d.riskClass).toBe('Barrier');
    expect(d.receiptCommitment).toBeNull();
    expect(bytesToHex(d.policyId)).toBe('739cce791c33ec85aa531b119da20f9624eaf7a4470e10e3282a3f65');
    expect(d.coverageAmount).toBe(419_540_000n);
  });

  it('encode→decode round-trips a V5 None datum', () => {
    const d = { ...dd56e6df(), receiptCommitment: null };
    const back = decodePolicyDatum(encodePolicyDatumV5(d));
    expect(back).toEqual(d);
  });

  it('encode→decode round-trips a V5 Some datum', () => {
    const d = { ...dd56e6df(), receiptCommitment: COMMITMENT };
    const back = decodePolicyDatum(encodePolicyDatumV5(d));
    expect(back.receiptCommitment).not.toBeNull();
    expect(bytesToHex(back.receiptCommitment!)).toBe(bytesToHex(COMMITMENT));
    expect(back).toEqual(d);
  });

  it('round-trips a partner-address (Some, with stake) V5 datum', () => {
    const d: PolicyDatum = {
      ...dd56e6df(),
      partnerAddress: {
        paymentVkh: hexToBytes('00112233445566778899aabbccddeeff00112233445566778899aabb'),
        stakeVkh: hexToBytes('ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544'),
      },
      partnerShareBps: 2_000n,
      receiptCommitment: COMMITMENT,
    };
    const back = decodePolicyDatum(encodePolicyDatumV5(d));
    expect(back).toEqual(d);
  });
});
