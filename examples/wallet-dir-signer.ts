/**
 * examples/wallet-dir-signer.ts
 *
 * A CIP-30-shaped signer over a wallet directory holding public.json and mnemonic.txt, for
 * scripts and test wallets. The mnemonic is read inside each call that signs, the CIP-1852
 * account-0 keys are derived from it (Icarus master key, m/1852'/1815'/0'/0/0 and .../2/0),
 * and the key bytes are zeroed before the call returns. A wallet whose mnemonic derives
 * another address or payment key hash than its public.json names is refused. Nothing here
 * prints or returns a key; signTx answers a witness set and signData a CIP-30 DataSignature.
 *
 * In a browser, pass the wallet's own CIP-30 API instead: it answers the same three calls.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2b.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** The three CIP-30 calls a sale needs, every value hex as CIP-30 has it. */
export interface Cip30Signer {
  /** The address bytes, hex. */
  getChangeAddress(): Promise<string>;
  /** A witness set holding one vkey witness over the transaction's body. */
  signTx(tx: string, partialSign: boolean): Promise<string>;
  signData(address: string, payload: string): Promise<{ signature: string; key: string }>;
}

interface PublicJson {
  network: string;
  address: string;
  payment_vkh: string;
}

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const HARDENED = 0x80000000;

function leInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function leBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function publicKey(kL: Uint8Array): Uint8Array {
  return ed25519.ExtendedPoint.BASE.multiply(leInt(kL) % L).toRawBytes();
}

/** BIP32-Ed25519 child derivation (V2, as Cardano wallets derive). */
function child(key: Uint8Array, index: number): Uint8Array {
  const [kL, kR, cc] = [key.slice(0, 32), key.slice(32, 64), key.slice(64, 96)];
  const i = new Uint8Array(4);
  new DataView(i.buffer).setUint32(0, index >>> 0, true);
  const hardened = index >= HARDENED;
  const material = hardened ? [kL, kR] : [publicKey(kL)];
  const tagged = (tag: number) => new Uint8Array([tag, ...material.flatMap((m) => [...m]), ...i]);
  const z = hmac(sha512, cc, tagged(hardened ? 0x00 : 0x02));
  const c = hmac(sha512, cc, tagged(hardened ? 0x01 : 0x03)).slice(32);
  const childL = leBytes(leInt(z.slice(0, 28)) * 8n + leInt(kL), 32);
  const childR = leBytes((leInt(z.slice(32)) + leInt(kR)) % 2n ** 256n, 32);
  [kL, kR, cc, z].forEach((b) => b.fill(0));
  return new Uint8Array([...childL, ...childR, ...c]);
}

/** The Icarus master key of a BIP-39 mnemonic with an empty passphrase. */
function master(mnemonic: string): Uint8Array {
  const entropy = mnemonicToEntropy(mnemonic.trim().split(/\s+/).join(' '), wordlist);
  const key = pbkdf2(sha512, new Uint8Array(), entropy, { c: 4096, dkLen: 96 });
  entropy.fill(0);
  key[0] &= 0xf8;
  key[31] &= 0x1f;
  key[31] |= 0x40;
  return key;
}

function derive(key: Uint8Array, path: number[]): Uint8Array {
  return path.reduce((k, index) => {
    const next = child(k, index);
    k.fill(0);
    return next;
  }, key);
}

function sign(key: Uint8Array, message: Uint8Array): Uint8Array {
  const [kL, kR] = [key.slice(0, 32), key.slice(32, 64)];
  const a = leInt(kL) % L;
  const vkey = publicKey(kL);
  const r = leInt(sha512(new Uint8Array([...kR, ...message]))) % L;
  const R = ed25519.ExtendedPoint.BASE.multiply(r).toRawBytes();
  const h = leInt(sha512(new Uint8Array([...R, ...vkey, ...message]))) % L;
  [kL, kR].forEach((b) => b.fill(0));
  return new Uint8Array([...R, ...leBytes((r + h * a) % L, 32)]);
}

function bstr(bytes: Uint8Array): number[] {
  const n = bytes.length;
  const head = n < 24 ? [0x40 + n] : n < 256 ? [0x58, n] : [0x59, n >> 8, n & 0xff];
  return [...head, ...bytes];
}

const PAYMENT = [1852 + HARDENED, 1815 + HARDENED, HARDENED, 0, 0];
const STAKE = [1852 + HARDENED, 1815 + HARDENED, HARDENED, 2, 0];

/** The signer of the wallet at `walletDir`, refused unless it is a `network` wallet whose keys derive its public.json. */
export function walletDirSigner(walletDir: string, network: string): Cip30Signer {
  const pub = JSON.parse(readFileSync(join(walletDir, 'public.json'), 'utf8')) as PublicJson;
  if (pub.network !== network) throw new Error(`${walletDir} is a ${pub.network} wallet, not a ${network} one`);
  const { prefix, words } = bech32.decode(pub.address as `${string}1${string}`, 120);
  if (prefix !== 'addr_test') throw new Error(`${walletDir} names no testnet address`);
  const address = Uint8Array.from(bech32.fromWords(words));

  /** `use(payment key, vkey)` on keys freshly derived and checked against public.json, zeroed after. */
  function withKey<T>(use: (key: Uint8Array, vkey: Uint8Array) => T): T {
    const root = master(readFileSync(join(walletDir, 'mnemonic.txt'), 'utf8'));
    const stake = derive(root.slice(), STAKE);
    const key = derive(root, PAYMENT);
    try {
      const vkey = publicKey(key.slice(0, 32));
      const derived = new Uint8Array([0x00, ...blake2b(vkey, { dkLen: 28 }), ...blake2b(publicKey(stake.slice(0, 32)), { dkLen: 28 })]);
      if (bytesToHex(derived.slice(1, 29)) !== pub.payment_vkh || bytesToHex(derived) !== bytesToHex(address)) {
        throw new Error(`${walletDir}'s mnemonic does not derive the wallet its public.json names`);
      }
      return use(key, vkey);
    } finally {
      key.fill(0);
      stake.fill(0);
    }
  }
  withKey(() => undefined);

  return {
    async getChangeAddress() {
      return bytesToHex(address);
    },
    async signTx(tx: string) {
      const body = bodyBytes(hexToBytes(tx));
      return withKey((key, vkey) => {
        const signature = sign(key, blake2b(body, { dkLen: 32 }));
        return bytesToHex(new Uint8Array([0xa1, 0x00, 0x81, 0x82, ...bstr(vkey), ...bstr(signature)]));
      });
    },
    async signData(addressHex: string, payload: string) {
      if (addressHex !== bytesToHex(address)) throw new Error('signData names an address this wallet does not hold');
      const message = hexToBytes(payload);
      const label = new TextEncoder().encode('address');
      const protectedHeader = new Uint8Array([0xa2, 0x01, 0x27, 0x60 + label.length, ...label, ...bstr(address)]);
      const signed = new Uint8Array([0x84, 0x6a, ...new TextEncoder().encode('Signature1'), ...bstr(protectedHeader), 0x40, ...bstr(message)]);
      return withKey((key, vkey) => {
        const signature = sign(key, signed);
        const hashed = new TextEncoder().encode('hashed');
        return {
          signature: bytesToHex(new Uint8Array([0x84, ...bstr(protectedHeader), 0xa1, 0x60 + hashed.length, ...hashed, 0xf4, ...bstr(message), ...bstr(signature)])),
          key: bytesToHex(new Uint8Array([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, ...bstr(vkey)])),
        };
      });
    },
  };
}

/** The raw bytes of a transaction's body: the first item of its top-level array. */
function bodyBytes(tx: Uint8Array): Uint8Array {
  if (tx[0] !== 0x84) throw new Error('signTx takes a four-item transaction');
  return tx.slice(1, 1 + itemLength(tx, 1));
}

/** The encoded length of the CBOR item at `at`. */
function itemLength(b: Uint8Array, at: number): number {
  const major = b[at] >> 5;
  const info = b[at] & 0x1f;
  let p = at + 1;
  let n = 0;
  if (info < 24) n = info;
  else if (info <= 27) {
    const size = 1 << (info - 24);
    for (let i = 0; i < size; i++) n = n * 256 + b[p + i];
    p += size;
  } else if (info === 31) {
    while (b[p] !== 0xff) p += itemLength(b, p);
    return p + 1 - at;
  } else throw new Error('a transaction carries a CBOR item this signer does not read');
  if (major === 2 || major === 3) return p + n - at;
  if (major === 4) for (let i = 0; i < n; i++) p += itemLength(b, p);
  else if (major === 5) for (let i = 0; i < 2 * n; i++) p += itemLength(b, p);
  else if (major === 6) p += itemLength(b, p);
  return p - at;
}
