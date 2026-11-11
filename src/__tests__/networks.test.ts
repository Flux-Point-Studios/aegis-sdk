// Chain facts per network and the CIP-19 address codec, preview included. The goldens
// are preview's own: Koios's network magic, the slot a landed borrow names as its
// validity bound, and the bech32 Koios lists that borrow's loan output under.

import { describe, it, expect } from 'vitest';
import { CHAIN_FACTS, posixMsToSlot, slotToPosixMs } from '../networks';
import { bech32Address, decodeBech32Address } from '../address';
import { bytesToHex, hexToBytes } from '../cbor';
import { InputError } from '../errors';
import loans from './fixtures/preview_borrower_loans.json';

const BORROWER =
  'addr_test1qr0prpt3anm70ey4dam4yp2v7jm6g8wsrzwe8vkvr279plkjlqjza7zcf2gs6ymzgdwck9at45ntyrva68jhrfjpym0q6k0yqq';

/** The message of the InputError `call` throws. */
function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (error instanceof InputError) return error.message;
    throw error;
  }
  throw new Error('the call was not refused');
}

describe('CHAIN_FACTS', () => {
  it('records preview as network magic 2, testnet id 0, slot zero at 1666656000 s, on Koios preview', () => {
    expect(CHAIN_FACTS.preview).toEqual({
      networkMagic: 2,
      networkId: 0,
      slotZeroPosixSeconds: 1666656000,
      koios: 'https://preview.koios.rest/api/v1',
    });
    expect(CHAIN_FACTS.preprod.networkMagic).toBe(1);
    expect(CHAIN_FACTS.mainnet.networkMagic).toBe(764824073);
  });
});

describe('slotToPosixMs / posixMsToSlot', () => {
  it("turns the landed borrow's validity bound, slot 127699013, into the lendDate its loan datum holds", () => {
    expect(slotToPosixMs(127699013n, 'preview')).toBe(1794355013000n);
    expect(posixMsToSlot(1794355013000n, 'preview')).toBe(127699013n);
  });

  it('refuses a time that is no whole slot', () => {
    expect(() => posixMsToSlot(1794355013001n, 'preview')).toThrow(/whole slot/);
    expect(() => posixMsToSlot(1794355013001n, 'preview')).toThrow(InputError);
  });
});

describe('bech32Address / decodeBech32Address', () => {
  it('writes a script payment and key stake address as Koios lists the loan output', () => {
    const row = loans.response[0];
    expect(
      bech32Address(
        {
          payment: { kind: 'script', hash: hexToBytes('31e0dc1d75076e4f7795b24c4cc4b5515791bb4eff4af7961e404f3e') },
          stake: { kind: 'key', hash: hexToBytes('d2f8242ef8584a910d1362435d8b17abad26b20d9dd1e571a64126de') },
        },
        'preview',
      ),
    ).toBe(row.address);
  });

  it("reads a base address's credentials and network id back", () => {
    const decoded = decodeBech32Address(BORROWER);
    expect(decoded.networkId).toBe(0);
    expect(decoded.payment.kind).toBe('key');
    expect(bytesToHex(decoded.payment.hash)).toBe(
      'de118571ecf7e7e4956f7752054cf4b7a41dd0189d93b2cc1abc50fe',
    );
    expect(decoded.stake).toEqual({ kind: 'key', hash: hexToBytes('d2f8242ef8584a910d1362435d8b17abad26b20d9dd1e571a64126de') });
    expect(bech32Address({ payment: decoded.payment, stake: decoded.stake }, 'preview')).toBe(BORROWER);
  });

  it('reads an enterprise address, header type 6 or 7, as its payment credential and no stake credential', () => {
    // Koios lists the reference scripts of preview's FluidTokens suite at this key enterprise address.
    expect(decodeBech32Address('addr_test1vpvx0sacufuypa2k4sngk7q40zc5c4npl337uusdh64kv0c7e4cxr')).toEqual({
      networkId: 0,
      payment: { kind: 'key', hash: hexToBytes('5867c3b8e27840f556ac268b781578b14c5661fc63ee720dbeab663f') },
      stake: null,
    });
    // The Aegis pool validator's script enterprise addresses on mainnet and preprod, as address.test.ts pins them.
    expect(decodeBech32Address('addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr')).toEqual({
      networkId: 1,
      payment: { kind: 'script', hash: hexToBytes('c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f') },
      stake: null,
    });
    expect(decodeBech32Address('addr_test1wr6harrzp9wzdcaknmzmsz02zq22zx4qdvuk5kjqyd0xgegwkary8')).toEqual({
      networkId: 0,
      payment: { kind: 'script', hash: hexToBytes('f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465') },
      stake: null,
    });
  });

  it("refuses an address whose header's network id is not its prefix's", () => {
    // The key enterprise address above with its header's network id swapped, each under a valid checksum.
    expect(refusalOf(() => decodeBech32Address('addr_test1v9vx0sacufuypa2k4sngk7q40zc5c4npl337uusdh64kv0c7t9fxy'))).toBe(
      'address network id 1 does not match its prefix addr_test',
    );
    expect(refusalOf(() => decodeBech32Address('addr1vpvx0sacufuypa2k4sngk7q40zc5c4npl337uusdh64kv0c9r34fp'))).toBe(
      'address network id 0 does not match its prefix addr',
    );
  });

  it('refuses a corrupted checksum and an address it does not read', () => {
    expect(() => decodeBech32Address(BORROWER.slice(0, -1) + 'p')).toThrow(/checksum/);
    expect(() => decodeBech32Address('stake_test1urf0sfpwlpvy4ygdzd3yxhvtz7466f4jpkwaret35eqjdhs7r6spt')).toThrow(
      /payment/,
    );
  });
});
