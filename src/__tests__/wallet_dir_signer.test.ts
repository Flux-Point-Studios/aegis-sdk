import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { walletDirSigner } from '../node/wallet_dir';
import { hexToBytes } from '../cbor';
import { decodeTransaction } from '../tx';
import landed from './fixtures/g3_preview_sale.json';

// The public BIP-39 test mnemonic and what pycardano 0.13 derives and signs with it.
const MNEMONIC = `${'abandon '.repeat(23)}art`;
const ADDRESS = 'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const ADDRESS_HEX =
  '0000b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fbc2f45a16a6685616e566c00fc081fe59f8bd7ab679ee15e9ce203446';
const PAYMENT_VKH = '00b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fb';
const VKEY = '63c5d69570349e4233a0575811464f0e8a3fd329abe76e9bdc3d3f1b95982179';
const SIGNED_DATA = {
  signature:
    '845846a20127676164647265737358390000b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fbc2f45a16a6685616e566c00fc081fe59f8bd7ab679ee15e9ce203446a166686173686564f44a7b226c616e65223a307d5840456e4685156f5948b19f5bd8851df168cb86700c8e0164851d0812e87381c8c0690cff500fef86e7460d938f3d5b1e2bd4dd6da1d813a287e6be44f9acd82401',
  key: 'a401010327200621582063c5d69570349e4233a0575811464f0e8a3fd329abe76e9bdc3d3f1b95982179',
};

function wallet(pub: Record<string, string>, mnemonic = MNEMONIC): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-wallet-'));
  writeFileSync(join(dir, 'public.json'), JSON.stringify({ network: 'preview', address: ADDRESS, payment_vkh: PAYMENT_VKH, ...pub }));
  writeFileSync(join(dir, 'mnemonic.txt'), `${mnemonic}\n`);
  return dir;
}

describe('walletDirSigner', () => {
  it("derives the wallet pycardano derives and answers CIP-30 signData as it signs", async () => {
    const signer = walletDirSigner(wallet({}), 'preview');
    expect(await signer.getChangeAddress()).toBe(ADDRESS_HEX);
    expect(await signer.signData(ADDRESS_HEX, '7b226c616e65223a307d')).toEqual(SIGNED_DATA);
  });

  it("witnesses a transaction's body with the payment key", async () => {
    const signer = walletDirSigner(wallet({}), 'preview');
    const witnessSet = await signer.signTx(landed.prepared, true);
    expect(witnessSet.slice(0, 12)).toBe('a10081825820');
    expect(witnessSet.slice(12, 76)).toBe(VKEY);
    expect(witnessSet.slice(76, 80)).toBe('5840');
    expect(witnessSet).toHaveLength(80 + 128);
    const signature = witnessSet.slice(-128);
    const id = decodeTransaction(landed.prepared).id;
    expect(ed25519.verify(hexToBytes(signature), hexToBytes(id), hexToBytes(VKEY))).toBe(true);
  });

  it.each<[string, Record<string, string>, string | undefined, RegExp]>([
    ['a wallet of another network', { network: 'preprod' }, undefined, /preprod wallet, not a preview one/],
    ['a public.json naming another key', { payment_vkh: '11'.repeat(28) }, undefined, /does not derive/],
    ['a mnemonic deriving another wallet', {}, `${'zoo '.repeat(23)}vote`, /does not derive/],
  ])('refuses %s', (_what, pub, mnemonic, expected) => {
    expect(() => walletDirSigner(wallet(pub, mnemonic), 'preview')).toThrow(expected);
  });

  it('refuses to sign data for an address it does not hold', async () => {
    const signer = walletDirSigner(wallet({}), 'preview');
    await expect(signer.signData('00'.repeat(57), '00')).rejects.toThrow(/does not hold/);
  });
});
