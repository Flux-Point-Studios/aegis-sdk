// CIP-19 enterprise script-address encoder — proven against KNOWN manifest
// addresses. The composer places the policy output at the policy validator's
// script address; an address-derivation bug would lock coverage at the wrong
// address, so these goldens (real deployed addresses from release/*.json) are
// the safety net. bech32 (not bech32m), header = 0b0111_<network>.

import { describe, it, expect } from 'vitest';
import { scriptEnterpriseAddress } from '../address';

describe('scriptEnterpriseAddress — golden vs deployed manifest addresses', () => {
  it('mainnet V4 pool validator hash → release/mainnet.json pool_address', () => {
    expect(
      scriptEnterpriseAddress('c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f', 'mainnet'),
    ).toBe('addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr');
  });

  it('mainnet V4 policy validator hash → policy script address', () => {
    expect(
      scriptEnterpriseAddress('1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7', 'mainnet'),
    ).toBe('addr1wyt80hz2qzysglhrzdk2004q7dhyn4nsw35gp86004rdldcnuy3ev');
  });

  it('preprod pool validator hash → release/preprod.json pool_address', () => {
    expect(
      scriptEnterpriseAddress('f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465', 'preprod'),
    ).toBe('addr_test1wr6harrzp9wzdcaknmzmsz02zq22zx4qdvuk5kjqyd0xgegwkary8');
  });

  it('rejects a non-28-byte hash', () => {
    expect(() => scriptEnterpriseAddress('abcd', 'mainnet')).toThrow();
  });
});

// Zero-premium-cover enrollment shapes: key payment + SCRIPT stake base
// address (CIP-19 type 2) and the script reward account (type 15). Goldens
// generated with pycardano 0.13.1 (the backend's encoder) so the SDK and the
// enroll build response can never disagree on where the principal lives.
import { hybridStakeAddress, scriptStakeAddress } from '../address';
import { hexToBytes } from '../cbor';

const ENROLLEE_VKH = hexToBytes('00112233445566778899aabbccddeeff00112233445566778899aabb');
const PS_HASH = 'e5c60e5c60e5c60e5c60e5c60e5c60e5c60e5c60e5c60e5c60e5c60e';

describe('hybridStakeAddress — key payment + script stake (enrollment address)', () => {
  it('mainnet golden (pycardano)', () => {
    expect(hybridStakeAddress(ENROLLEE_VKH, PS_HASH, 'mainnet')).toBe(
      'addr1yyqpzg3ng32kvaugnx4thnxaamlsqyfzxdz92enh3zv64wl9cc89cc89cc89cc89cc89cc89cc89cc89cc89cc89cc8qn2uuk2',
    );
  });

  it('preprod golden (pycardano)', () => {
    expect(hybridStakeAddress(ENROLLEE_VKH, PS_HASH, 'preprod')).toBe(
      'addr_test1yqqpzg3ng32kvaugnx4thnxaamlsqyfzxdz92enh3zv64wl9cc89cc89cc89cc89cc89cc89cc89cc89cc89cc89cc8qsupu64',
    );
  });

  it('rejects malformed credentials', () => {
    expect(() => hybridStakeAddress(new Uint8Array(27), PS_HASH, 'mainnet')).toThrow();
    expect(() => hybridStakeAddress(ENROLLEE_VKH, 'abcd', 'mainnet')).toThrow();
  });
});

describe('scriptStakeAddress — the per-enrollee reward account', () => {
  it('mainnet golden (pycardano)', () => {
    expect(scriptStakeAddress(PS_HASH, 'mainnet')).toBe(
      'stake178juvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrsjtyzx0',
    );
  });

  it('preprod golden (pycardano)', () => {
    expect(scriptStakeAddress(PS_HASH, 'preprod')).toBe(
      'stake_test17rjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrjuvrs4pwqzj',
    );
  });

  it('rejects a non-28-byte hash', () => {
    expect(() => scriptStakeAddress('abcd', 'preprod')).toThrow();
  });
});
