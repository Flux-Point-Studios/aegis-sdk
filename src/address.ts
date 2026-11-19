// CIP-19 enterprise script-address encoder (bech32), zero runtime deps.
//
// The composer must place the policy output at the policy validator's script
// address. Rather than push bech32 encoding onto the partner's tx framework,
// the SDK derives the bech32 directly from the deployed validator hash so the
// composed parts are immediately usable. Proven against the real deployed pool
// and policy addresses from release/*.json (see __tests__/address.test.ts).
//
// Enterprise address (no stake credential), script payment credential:
//   header byte = 0b0111_<network>   (0x71 mainnet, 0x70 testnet/preprod)
//   payload     = header(1) || script_hash(28)  = 29 bytes
//   bech32 (NOT bech32m) over the 5-bit regrouped payload, HRP "addr"/"addr_test".

import { bytesToHex, hexToBytes } from './cbor';
import { InputError } from './errors';
import { constrOf, dataHex } from './plutus_data';
import type { PlutusData } from './plutus_data';
import type { PlutusCredential, PlutusFullAddress } from './types';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  // bech32 (const 1); bech32m would use 0x2bc830a3. Cardano uses bech32.
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function bech32Encode(hrp: string, data: number[]): string {
  const combined = data.concat(createChecksum(hrp, data));
  let out = hrp + '1';
  for (const d of combined) out += CHARSET.charAt(d);
  return out;
}

/** Regroup `data` from 8-bit bytes to 5-bit words (with padding). */
function convertBits8to5(data: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = 31;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & maxv);
  return out;
}

export type Network = 'mainnet' | 'preprod' | 'preview';

function networkBit(network: Network): number {
  return network === 'mainnet' ? 1 : 0; // every testnet's id is 0
}

function encodeAddr(network: Network, payload: Uint8Array): string {
  const hrp = network === 'mainnet' ? 'addr' : 'addr_test';
  return bech32Encode(hrp, convertBits8to5(payload));
}

/**
 * Bech32 enterprise address for a Plutus script credential.
 *
 * @param scriptHashHex 56-char hex (28-byte blake2b-224 validator hash).
 * @param network 'mainnet' → addr1w…, 'preprod' (testnet id 0) → addr_test1w…
 */
export function scriptEnterpriseAddress(scriptHashHex: string, network: Network): string {
  const hash = hexToBytes(scriptHashHex);
  if (hash.length !== 28) {
    throw new Error(`script hash must be 28 bytes (got ${hash.length})`);
  }
  // header high nibble 0b0111 = enterprise + script payment cred.
  const payload = new Uint8Array(29);
  payload[0] = 0x70 | networkBit(network);
  payload.set(hash, 1);
  return encodeAddr(network, payload);
}

/**
 * Bech32 address for a verification-key payment credential. With a stake VKH it
 * is a base address (addr1q…/addr_test1q…); without one it is an enterprise key
 * address (addr1v…/addr_test1v…). Used for the partner fee output so the bech32
 * the partner is paid at matches the partner_address credential in the datum.
 */
export function keyAddress(
  paymentVkh: Uint8Array,
  stakeVkh: Uint8Array | null,
  network: Network,
): string {
  if (paymentVkh.length !== 28) {
    throw new Error(`payment vkh must be 28 bytes (got ${paymentVkh.length})`);
  }
  const net = networkBit(network);
  if (stakeVkh === null) {
    // header high nibble 0b0110 = enterprise + key payment cred.
    const payload = new Uint8Array(29);
    payload[0] = 0x60 | net;
    payload.set(paymentVkh, 1);
    return encodeAddr(network, payload);
  }
  if (stakeVkh.length !== 28) {
    throw new Error(`stake vkh must be 28 bytes (got ${stakeVkh.length})`);
  }
  // header high nibble 0b0000 = base + key payment cred + key stake cred.
  const payload = new Uint8Array(57);
  payload[0] = 0x00 | net;
  payload.set(paymentVkh, 1);
  payload.set(stakeVkh, 29);
  return encodeAddr(network, payload);
}

/**
 * Bech32 base address with a KEY payment credential and a SCRIPT stake
 * credential — the zero-premium-cover enrollment shape: the principal stays
 * spendable by the payment key alone (the stake script is never invoked for
 * spending), while delegation + reward withdrawal are governed by the
 * per-enrollee premium_stake script. CIP-19 header 0b0010_<network>.
 *
 * @param paymentVkh 28-byte payment key hash (the enrollee).
 * @param stakeScriptHashHex 56-char hex per-enrollee premium_stake hash
 *   (take `summary.premium_stake_hash` from the enroll build response — param
 *   application needs the backend's UPLC applicator).
 */
export function hybridStakeAddress(
  paymentVkh: Uint8Array,
  stakeScriptHashHex: string,
  network: Network,
): string {
  if (paymentVkh.length !== 28) {
    throw new Error(`payment vkh must be 28 bytes (got ${paymentVkh.length})`);
  }
  const stakeHash = hexToBytes(stakeScriptHashHex);
  if (stakeHash.length !== 28) {
    throw new Error(`stake script hash must be 28 bytes (got ${stakeHash.length})`);
  }
  // header high nibble 0b0010 = base + key payment cred + script stake cred.
  const payload = new Uint8Array(57);
  payload[0] = 0x20 | networkBit(network);
  payload.set(paymentVkh, 1);
  payload.set(stakeHash, 29);
  return encodeAddr(network, payload);
}

/**
 * Bech32 reward-account (stake) address for a SCRIPT stake credential — where
 * an enrollee's staking rewards accrue between harvests. CIP-19 header
 * 0b1111_<network>, HRP "stake"/"stake_test". Feed it to account-state reads
 * (withdrawable balance, delegation, registered flag).
 */
export function scriptStakeAddress(stakeScriptHashHex: string, network: Network): string {
  const stakeHash = hexToBytes(stakeScriptHashHex);
  if (stakeHash.length !== 28) {
    throw new Error(`stake script hash must be 28 bytes (got ${stakeHash.length})`);
  }
  const payload = new Uint8Array(29);
  payload[0] = 0xf0 | networkBit(network);
  payload.set(stakeHash, 1);
  const hrp = network === 'mainnet' ? 'stake' : 'stake_test';
  return bech32Encode(hrp, convertBits8to5(payload));
}

/**
 * Build a full Plutus address with a SCRIPT payment credential and no stake
 * credential (an enterprise script address). This is the typical shape for a
 * contract-controlled payout target — e.g. a governance/treasury or
 * native-multisig script that should receive the Claim coverage. Pass the
 * result as the `payout` option to `buildUnderwriteParts`.
 *
 * @param scriptHashHex 56-char hex (28-byte validator / native-script hash).
 */
export function scriptPayoutTarget(scriptHashHex: string): PlutusFullAddress {
  const hash = hexToBytes(scriptHashHex);
  if (hash.length !== 28) {
    throw new Error(`script hash must be 28 bytes (got ${hash.length})`);
  }
  return { payment: { kind: 'script', hash }, stake: null };
}

/** CIP-19 address type (the header's high nibble) of a base or enterprise address. */
const ADDRESS_TYPE: Record<string, number> = {
  'key/key': 0,
  'script/key': 1,
  'key/script': 2,
  'script/script': 3,
  'key/none': 6,
  'script/none': 7,
};

function credentialBytes(c: PlutusCredential, role: string): Uint8Array {
  if (c.hash.length !== 28) throw new InputError('INVALID_INPUT', `${role} credential must be 28 bytes (got ${c.hash.length})`);
  return c.hash;
}

/** The bytes, hex, of a base or enterprise address on network id `networkId`: what an output carries. */
export function addressHex(addr: PlutusFullAddress, networkId: number): string {
  const type = ADDRESS_TYPE[`${addr.payment.kind}/${addr.stake?.kind ?? 'none'}`];
  const parts = [credentialBytes(addr.payment, 'payment'), ...(addr.stake ? [credentialBytes(addr.stake, 'stake')] : [])];
  return ((type << 4) | networkId).toString(16).padStart(2, '0') + parts.map(bytesToHex).join('');
}

/**
 * Bech32 base or enterprise address for any payment and optional stake credential, each a
 * key or a script: the general form of {@link keyAddress}, {@link scriptEnterpriseAddress}
 * and {@link hybridStakeAddress}.
 */
export function bech32Address(addr: PlutusFullAddress, network: Network): string {
  const type = ADDRESS_TYPE[`${addr.payment.kind}/${addr.stake?.kind ?? 'none'}`];
  const parts = [credentialBytes(addr.payment, 'payment')];
  if (addr.stake !== null) parts.push(credentialBytes(addr.stake, 'stake'));
  const payload = new Uint8Array(1 + 28 * parts.length);
  payload[0] = (type << 4) | networkBit(network);
  parts.forEach((p, i) => payload.set(p, 1 + 28 * i));
  return encodeAddr(network, payload);
}

export interface DecodedAddress extends PlutusFullAddress {
  /** 1 on mainnet, 0 on every testnet. */
  networkId: 0 | 1;
}

/** Regroup 5-bit words into bytes, refusing padding that is more than zero bits under a byte. */
function convertBits5to8(words: number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) throw new InputError('INVALID_INPUT', 'bech32 address has bad padding');
  return new Uint8Array(out);
}

/**
 * The bytes a bech32 Shelley address (payment or reward) spells, its network id checked
 * against its prefix: what a transaction output or a withdrawal carries.
 */
export function addressBytes(address: string): Uint8Array {
  const lower = address.toLowerCase();
  if (lower !== address && address.toUpperCase() !== address) {
    throw new InputError('INVALID_INPUT', 'bech32 address mixes cases');
  }
  const sep = lower.lastIndexOf('1');
  const hrp = lower.slice(0, sep);
  if (!['addr', 'addr_test', 'stake', 'stake_test'].includes(hrp)) {
    throw new InputError('INVALID_INPUT', `a ${hrp || 'headless'} bech32 string is no address`);
  }
  const words = Array.from(lower.slice(sep + 1), (ch) => CHARSET.indexOf(ch));
  if (words.length < 6 || words.some((w) => w < 0)) throw new InputError('INVALID_INPUT', 'bech32 address has a bad character');
  if (polymod(hrpExpand(hrp).concat(words)) !== 1) throw new InputError('INVALID_INPUT', 'bech32 address has a bad checksum');
  const bytes = convertBits5to8(words.slice(0, -6));
  if (bytes.length === 0) throw new InputError('INVALID_INPUT', 'bech32 address carries no header');
  const networkId = bytes[0] & 0x0f;
  if (networkId !== (hrp.endsWith('_test') ? 0 : 1)) {
    throw new InputError('INVALID_INPUT', `address network id ${networkId} does not match its prefix ${hrp}`);
  }
  const reward = bytes[0] >> 5 === 7;
  if (reward !== hrp.startsWith('stake')) {
    throw new InputError('INVALID_INPUT', `a ${reward ? 'reward' : 'payment'} address under the prefix ${hrp}`);
  }
  return bytes;
}

/**
 * The credentials and network id of a bech32 base or enterprise address (CIP-19 types 0-3,
 * 6, 7). A pointer, Byron or reward address carries no payment and inline stake pair this
 * reads, and is refused.
 */
export function decodeBech32Address(address: string): DecodedAddress {
  if (/^stake/i.test(address)) throw new InputError('INVALID_INPUT', 'a stake bech32 string is no payment address');
  const bytes = addressBytes(address);
  const type = bytes[0] >> 4;
  const networkId = bytes[0] & 0x0f;
  const kinds = Object.keys(ADDRESS_TYPE).find((k) => ADDRESS_TYPE[k] === type);
  const [payment, stake] = (kinds ?? '').split('/') as ['key' | 'script', 'key' | 'script' | 'none'];
  if (kinds === undefined || bytes.length !== (stake === 'none' ? 29 : 57)) {
    throw new InputError('INVALID_INPUT', `address type ${type} carries no payment and inline stake credentials this reads`);
  }
  return {
    networkId: networkId as 0 | 1,
    payment: { kind: payment, hash: bytes.slice(1, 29) },
    stake: stake === 'none' ? null : { kind: stake, hash: bytes.slice(29, 57) },
  };
}

function credentialOf(node: PlutusData, what: string): { kind: 'key' | 'script'; hash: Uint8Array } {
  const c = constrOf(node, what);
  if (c.constructor > 1 || c.fields.length !== 1) throw new InputError('INVALID_INPUT', `${what} is no credential`);
  return { kind: c.constructor === 0 ? 'key' : 'script', hash: hexToBytes(dataHex(c.fields[0], what)) };
}

/** An Address as Data, inline stake only, as its bytes on `networkId`. */
export function addressHexOfData(node: PlutusData, networkId: number): string {
  const [payment, stake] = constrOf(node, 'an address').fields;
  const pay = credentialOf(payment, 'the payment credential');
  const opt = constrOf(stake, 'the stake credential');
  const inlineStake = opt.constructor === 0 ? constrOf(opt.fields[0], 'the stake reference') : null;
  if (inlineStake && inlineStake.constructor !== 0) throw new InputError('INVALID_INPUT', 'a pointer stake credential is no address this writes');
  const st = inlineStake ? credentialOf(inlineStake.fields[0], 'the stake credential') : null;
  return addressHex({ payment: pay, stake: st }, networkId);
}

/** The credentials of a base or enterprise address's bytes, hex. */
export function fullAddressOfHex(hex: string): PlutusFullAddress {
  const bytes = hexToBytes(hex);
  const type = bytes[0] >> 4;
  if (type > 3 && type !== 6 && type !== 7) throw new InputError('INVALID_INPUT', 'an address that is no base or enterprise address');
  return {
    payment: { kind: type & 1 ? 'script' : 'key', hash: bytes.slice(1, 29) },
    stake: type < 4 ? { kind: type & 2 ? 'script' : 'key', hash: bytes.slice(29, 57) } : null,
  };
}
