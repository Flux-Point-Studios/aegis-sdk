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

import { hexToBytes } from './cbor';
import type { PlutusFullAddress } from './types';

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

export type Network = 'mainnet' | 'preprod';

function networkBit(network: Network): number {
  return network === 'mainnet' ? 1 : 0; // testnet/preprod id = 0
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
