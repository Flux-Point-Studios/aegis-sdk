// The wallet directory signs as the Python wallet_signer does: CIP-30 signData's COSE_Sign1
// and COSE_Key, and the body witness spliced into the unsigned bytes, byte for byte
// (fixtures/g3_cli_vectors.json).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressBytes } from '../address';
import { bytesToHex } from '../cbor';
import { openWalletDir } from '../node/wallet_dir';
import { spliceVkeyWitnesses, transactionId } from '../tx';
import vectors from './fixtures/g3_cli_vectors.json';

const V = vectors as any;

function walletDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-g3-wallet-'));
  writeFileSync(join(dir, 'public.json'), JSON.stringify(V.public));
  writeFileSync(join(dir, 'mnemonic.txt'), V.mnemonic);
  return dir;
}

describe('a wallet directory', () => {
  it('names the address and key its public.json does', () => {
    const wallet = openWalletDir(walletDir(), 'preview');
    expect(wallet.address).toBe(V.public.address);
    expect(wallet.vkh).toBe(V.public.payment_vkh);
  });

  it("signs data as the Python signer does", async () => {
    const wallet = openWalletDir(walletDir(), 'preview');
    for (const v of V.signing.sign_data) {
      const answer = await wallet.signer.signData(bytesToHex(addressBytes(v.address)), v.payload);
      expect(answer).toEqual({ signature: v.signature, key: v.key });
    }
  });

  it('witnesses a body into the bytes the Python signer writes', async () => {
    const wallet = openWalletDir(walletDir(), 'preview');
    const witnessSet = await wallet.signer.signTx(V.signing.unsigned, false);
    const signed = spliceVkeyWitnesses(V.signing.unsigned, witnessSet);
    expect(signed).toBe(V.signing.signed);
    expect(transactionId(signed)).toBe(V.signing.tx_id);
  });
});
