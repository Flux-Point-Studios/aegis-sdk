// PolicyRedeemer CBOR conformance vs api/policies.py truth source.
//
// Aiken PolicyRedeemer is a 5-variant enum with NO fields per branch:
//   Claim=0, BatchClaim=1, Expire=2, BatchExpire=3, Cancel=4.
// All five serialise as the bare `d8 79+i 80` empty-constr form.

import { describe, it, expect } from 'vitest';
import {
  encodePolicyRedeemer,
  decodePolicyRedeemer,
  bytesToHex,
} from '../cbor';
import type { PolicyRedeemer } from '../types';

describe('PolicyRedeemer CBOR', () => {
  const cases: Array<[PolicyRedeemer, string]> = [
    [{ kind: 'Claim' }, 'd87980'],
    [{ kind: 'BatchClaim' }, 'd87a80'],
    [{ kind: 'Expire' }, 'd87b80'],
    [{ kind: 'BatchExpire' }, 'd87c80'],
    [{ kind: 'Cancel' }, 'd87d80'],
  ];

  for (const [r, hex] of cases) {
    it(`${r.kind} -> ${hex}`, () => {
      expect(bytesToHex(encodePolicyRedeemer(r))).toBe(hex);
    });
  }

  it('round-trips all variants', () => {
    for (const [r] of cases) {
      const enc = encodePolicyRedeemer(r);
      const dec = decodePolicyRedeemer(enc);
      expect(dec).toEqual(r);
    }
  });
});
