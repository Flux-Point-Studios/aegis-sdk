// LP token mint policy redeemer (MintLP / BurnLP) -- two 0-field variants.

import { describe, it, expect } from 'vitest';
import {
  encodeLPTokenRedeemer,
  decodeLPTokenRedeemer,
  bytesToHex,
} from '../cbor';
import type { LPTokenRedeemer } from '../types';

describe('LPTokenRedeemer CBOR', () => {
  it('MintLP -> d87980', () => {
    expect(bytesToHex(encodeLPTokenRedeemer({ kind: 'MintLP' }))).toBe('d87980');
  });

  it('BurnLP -> d87a80', () => {
    expect(bytesToHex(encodeLPTokenRedeemer({ kind: 'BurnLP' }))).toBe('d87a80');
  });

  it('round-trips both variants', () => {
    const variants: LPTokenRedeemer[] = [{ kind: 'MintLP' }, { kind: 'BurnLP' }];
    for (const r of variants) {
      expect(decodeLPTokenRedeemer(encodeLPTokenRedeemer(r))).toEqual(r);
    }
  });
});
