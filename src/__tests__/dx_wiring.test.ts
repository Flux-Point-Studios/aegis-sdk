// Verifies the DX layer is wired into the composer/quote: typed errors with
// codes, reasonCode on verdicts, the all-gates preflight, the manifest guard,
// and the trace hook.

import { describe, it, expect } from 'vitest';
import {
  buildUnderwriteParts,
  preflightUnderwrite,
  assertPoolMatchesManifest,
} from '../compose';
import { quoteForPosition } from '../quote';
import { AegisError, InsurabilityError, PoolError, InputError, ChainError } from '../errors';
import { hexToBytes } from '../cbor';
import type { PoolDatum } from '../types';

const BINDINGS = {
  network: 'mainnet' as const,
  policyValidatorHash: '1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7',
  poolValidatorHash: 'c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f',
  poolAddress: 'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr',
  poolNftPolicyId: '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3',
  poolNftAssetNameHex: '41454749535f504f4f4c5f5634',
  markerPolicyId: 'd9d24db4e4dabdc1af6a568a4ecd691b81fae891afd70eb6cabc51e7',
  teamAddress: 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3',
};
function pool(over: Partial<PoolDatum> = {}): { utxoRef: { txHash: string; index: number }; lovelace: bigint; datum: PoolDatum } {
  return {
    utxoRef: { txHash: 'aa'.repeat(32), index: 0 },
    lovelace: 10_000_000_000n,
    datum: {
      totalLiquidity: 10_000_000_000n,
      activeCoverage: 1_000_000_000n,
      lpTokenPolicy: hexToBytes('5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b'),
      protocolFeeBps: 200n,
      poolNft: hexToBytes('9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3'),
      lpSupply: 5_000_000_000n,
      ...over,
    },
  };
}
const BASE = {
  insuredPkh: 'ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931',
  strikePriceScaled: 600_000n,
  spotPriceScaled: 800_000n,
  coverageLovelace: 200_000_000n,
  premiumLovelace: 80_196_647n,
  durationDays: 30,
  oraclePolicyId: '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f',
  riskClass: 'Barrier' as const,
  nowMs: 1_750_000_000_000,
};

describe('typed errors from buildUnderwriteParts', () => {
  it('below-floor premium → InsurabilityError code BELOW_FLOOR with a hint', () => {
    try {
      buildUnderwriteParts({ bindings: BINDINGS, pool: pool(), ...BASE, premiumLovelace: 5_000_000n });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InsurabilityError);
      expect(e).toBeInstanceOf(AegisError);
      expect((e as AegisError).code).toBe('BELOW_FLOOR');
      expect((e as AegisError).hint).toMatch(/floor|lovelace/i);
    }
  });

  it('concentration cap → PoolError code CONCENTRATION_CAP', () => {
    try {
      buildUnderwriteParts({ bindings: BINDINGS, pool: pool({ totalLiquidity: 3_400_000_000n, activeCoverage: 3_200_000_000n }), ...BASE });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoolError);
      expect((e as AegisError).code).toBe('CONCENTRATION_CAP');
    }
  });

  it('bad insuredPkh → InputError code INVALID_INPUT', () => {
    try {
      buildUnderwriteParts({ bindings: BINDINGS, pool: pool(), ...BASE, insuredPkh: 'abcd' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect((e as AegisError).code).toBe('INVALID_INPUT');
    }
  });
});

describe('reasonCode on verdicts', () => {
  it('sets a machine-readable code per gate', () => {
    expect(quoteForPosition({ riskClass: 'Barrier', coverageLovelace: 100_000_000n, strikePriceScaled: 851_000n, spotPriceScaled: 1_000_000n, durationDays: 30 }).reasonCode).toBe('BELOW_MIN_STRIKE_DISTANCE');
    expect(quoteForPosition({ riskClass: 'Barrier', coverageLovelace: 100_000_000n, strikePriceScaled: 850_000n, spotPriceScaled: 1_000_000n, durationDays: 120 }).reasonCode).toBe('DEAD_ZONE');
    expect(quoteForPosition({ riskClass: 'Depeg', coverageLovelace: 100_000_000n, strikePriceScaled: 990_000n, durationDays: 30 }).reasonCode).toBe('DEPEG_STRIKE_OUT_OF_BAND');
    const ok = quoteForPosition({ riskClass: 'Barrier', coverageLovelace: 200_000_000n, strikePriceScaled: 600_000n, spotPriceScaled: 800_000n, durationDays: 30, premiumLovelace: 80_196_647n });
    expect(ok.insurable).toBe(true);
    expect(ok.reasonCode).toBeNull();
  });
});

describe('preflightUnderwrite — all gates at once', () => {
  it('passes a good policy with every check ok', () => {
    const r = preflightUnderwrite({ pool: pool(), coverageLovelace: 200_000_000n, premiumLovelace: 80_196_647n, strikePriceScaled: 600_000n, spotPriceScaled: 800_000n, durationDays: 30, riskClass: 'Barrier' });
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.verdict.insurable).toBe(true);
  });

  it('reports MULTIPLE blockers at once (not just the first)', () => {
    // under-priced premium (floor + ratio both fail) AND coverage exceeds the pool
    const r = preflightUnderwrite({
      pool: pool({ totalLiquidity: 100_000_000n, activeCoverage: 0n }),
      coverageLovelace: 5_000_000_000n,
      premiumLovelace: 2_000_000n,
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      durationDays: 30,
      riskClass: 'Barrier',
    });
    expect(r.ok).toBe(false);
    const gates = r.blockers.map((b) => b.gate);
    expect(gates).toContain('ratio<=50x');
    expect(gates).toContain('pool-can-cover');
    expect(r.blockers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('assertPoolMatchesManifest', () => {
  it('passes when the live pool NFT matches the bindings', () => {
    expect(() => assertPoolMatchesManifest(pool().datum, BINDINGS)).not.toThrow();
  });
  it('throws ChainError MANIFEST_MISMATCH on a redeployed pool', () => {
    const stale = pool({ poolNft: hexToBytes('35c08c6208244791f313db85a7734523b1f7d9bb76891f565611fe94') }).datum;
    try {
      assertPoolMatchesManifest(stale, BINDINGS);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ChainError);
      expect((e as AegisError).code).toBe('MANIFEST_MISMATCH');
    }
  });
});

describe('onTrace hook', () => {
  it('emits trace events during a build', () => {
    const events: string[] = [];
    buildUnderwriteParts({ bindings: BINDINGS, pool: pool(), ...BASE, onTrace: (e) => events.push(e) });
    expect(events).toContain('insurability');
    expect(events).toContain('pool-math');
  });
});
