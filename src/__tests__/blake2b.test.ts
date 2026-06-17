import { describe, it, expect } from 'vitest';
import { blake2b, blake2b224, derivePolicyId } from '../blake2b';
import { bytesToHex } from '../cbor';

// Goldens produced by the reference algorithm (Python `hashlib.blake2b`,
// digest_size=28), mirroring api/policies.py::_generate_policy_id line-for-line.
// The raw vectors below validate the hand-rolled BLAKE2b core independently of
// the Aegis preimage construction; the derivePolicyId cases validate the
// preimage byte-layout against the authoritative off-chain spec.

describe('blake2b-224 raw vectors (vs hashlib reference)', () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ['empty', new Uint8Array(0), '836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07'],
    ['"abc"', new TextEncoder().encode('abc'), '9bd237b02a29e43bdd6738afa5b53ff0eee178d6210b618e4511aec8'],
    ['64×0xaa', new Uint8Array(64).fill(0xaa), 'cca34f257e0694aa4292c971ed2aec259b957b44a196d730ddf7aa1e'],
    ['130×0x00 (two blocks)', new Uint8Array(130), 'bc7df64d67e9a7a296abf2aa093be95f79543544f8ab07123eb1eef4'],
  ];

  for (const [label, input, expected] of cases) {
    it(`hashes ${label}`, () => {
      expect(bytesToHex(blake2b224(input))).toBe(expected);
    });
  }

  it('blake2b224 === blake2b(input, 28)', () => {
    const input = new TextEncoder().encode('aegis');
    expect(bytesToHex(blake2b224(input))).toBe(bytesToHex(blake2b(input, 28)));
  });

  it('supports a non-28 digest length (e.g. 32-byte)', () => {
    // hashlib.blake2b(b"abc", digest_size=32).hexdigest()
    expect(bytesToHex(blake2b(new TextEncoder().encode('abc'), 32))).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    );
  });
});

describe('derivePolicyId (vs api/policies.py::_generate_policy_id)', () => {
  const INSURED = '00112233445566778899aabbccddeeff00112233445566778899aabb';
  const POOL_NFT = 'da986312812002c71c24a04156c61e65b7e38bb2f81322618eff2725';
  const TXID = '31b51d9384c0acd6291588db12f81e936631a527c2f5269b5fee224f9d7d461d';

  it('single-underwrite preimage (80 bytes)', () => {
    const pid = derivePolicyId({
      insuredPkh: INSURED,
      strikePriceScaled: 900000n,
      coverageLovelace: 2000000n,
      startTimeMs: 1750000000000n,
      expiryTimeMs: 1750604800000n,
      poolNft: POOL_NFT,
      underwriteTxHash: TXID,
      underwriteOutputIndex: 1,
    });
    expect(pid.length).toBe(28);
    expect(bytesToHex(pid)).toBe('3dfd052180b199ac86b28c9faade01a719767777600ce4e0ec3f675d');
  });

  it('batch-underwrite preimage (82 bytes, +batchIndex salt)', () => {
    const pid = derivePolicyId({
      insuredPkh: INSURED,
      strikePriceScaled: 900000n,
      coverageLovelace: 2000000n,
      startTimeMs: 1750000000000n,
      expiryTimeMs: 1750604800000n,
      poolNft: POOL_NFT,
      underwriteTxHash: TXID,
      underwriteOutputIndex: 1,
      batchIndex: 3,
    });
    expect(bytesToHex(pid)).toBe('ab11ae1cd65607db224484b6566b30c4f590a42b029c907044e37a70');
  });

  it('distinct terms produce the distinct golden (field-order guard)', () => {
    const pid = derivePolicyId({
      insuredPkh: 'ae725d47b1f9a0c3d2e4f6081a2b3c4d5e6f7a8b9c0d1e2f30415263',
      strikePriceScaled: 500000n,
      coverageLovelace: 419540000n,
      startTimeMs: 1781660781359n,
      expiryTimeMs: 1782438381359n,
      poolNft: '9a649b75c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7',
      underwriteTxHash: 'c5f4880000000000000000000000000000000000000000000000000000000000',
      underwriteOutputIndex: 0,
    });
    expect(bytesToHex(pid)).toBe('8c80629d8799f6c1f03a743097b5316785923f45c3a50b6512394a8c');
  });

  it('accepts poolNft as raw bytes', () => {
    const fromHex = derivePolicyId({
      insuredPkh: INSURED,
      strikePriceScaled: 900000n,
      coverageLovelace: 2000000n,
      startTimeMs: 1750000000000n,
      expiryTimeMs: 1750604800000n,
      poolNft: POOL_NFT,
      underwriteTxHash: TXID,
      underwriteOutputIndex: 1,
    });
    const fromBytes = derivePolicyId({
      insuredPkh: INSURED,
      strikePriceScaled: 900000n,
      coverageLovelace: 2000000n,
      startTimeMs: 1750000000000n,
      expiryTimeMs: 1750604800000n,
      poolNft: Uint8Array.from(Buffer.from(POOL_NFT, 'hex')),
      underwriteTxHash: TXID,
      underwriteOutputIndex: 1,
    });
    expect(bytesToHex(fromBytes)).toBe(bytesToHex(fromHex));
  });

  it('rejects malformed field lengths', () => {
    const base = {
      insuredPkh: INSURED,
      strikePriceScaled: 900000n,
      coverageLovelace: 2000000n,
      startTimeMs: 1750000000000n,
      expiryTimeMs: 1750604800000n,
      poolNft: POOL_NFT,
      underwriteTxHash: TXID,
      underwriteOutputIndex: 1,
    };
    expect(() => derivePolicyId({ ...base, insuredPkh: 'dead' })).toThrow(/28 bytes/);
    expect(() => derivePolicyId({ ...base, poolNft: 'dead' })).toThrow(/28 bytes/);
    expect(() => derivePolicyId({ ...base, underwriteTxHash: 'dead' })).toThrow(/32 bytes/);
  });
});
