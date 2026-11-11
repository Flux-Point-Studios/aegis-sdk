// Chain facts per Cardano network: the network magic a node answers with, the network
// id addresses carry, the POSIX second of the Shelley-era slot origin, and the public
// Koios endpoint. Slots are one second on every network listed, so a slot and a POSIX
// time convert by the origin alone.

import type { Network } from './address';
import { InputError } from './errors';

export interface ChainFacts {
  networkMagic: number;
  networkId: 0 | 1;
  /** POSIX seconds of slot 0 under the Shelley-era one-second slots. */
  slotZeroPosixSeconds: number;
  koios: string;
}

export const CHAIN_FACTS: Readonly<Record<Network, ChainFacts>> = {
  mainnet: {
    networkMagic: 764824073,
    networkId: 1,
    slotZeroPosixSeconds: 1591566291,
    koios: 'https://api.koios.rest/api/v1',
  },
  preprod: {
    networkMagic: 1,
    networkId: 0,
    slotZeroPosixSeconds: 1655683200,
    koios: 'https://preprod.koios.rest/api/v1',
  },
  preview: {
    networkMagic: 2,
    networkId: 0,
    slotZeroPosixSeconds: 1666656000,
    koios: 'https://preview.koios.rest/api/v1',
  },
};

/** The POSIX milliseconds a slot starts at: what a validity bound reads as in a script. */
export function slotToPosixMs(slot: bigint, network: Network): bigint {
  return (slot + BigInt(CHAIN_FACTS[network].slotZeroPosixSeconds)) * 1000n;
}

/** The slot starting at `ms`; a time inside a slot names no bound a transaction can carry. */
export function posixMsToSlot(ms: bigint, network: Network): bigint {
  if (ms % 1000n !== 0n) throw new InputError('INVALID_INPUT', `${ms} ms is not a whole slot`);
  return ms / 1000n - BigInt(CHAIN_FACTS[network].slotZeroPosixSeconds);
}
