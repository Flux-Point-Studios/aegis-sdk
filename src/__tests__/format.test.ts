import { describe, it, expect } from 'vitest';
import { formatAda, formatUsdScaled, formatParts } from '../format';
import { buildUnderwriteParts } from '../compose';
import { hexToBytes } from '../cbor';
import type { PoolDatum } from '../types';

describe('formatAda', () => {
  it('formats lovelace as ADA, trimming trailing zeros, grouping thousands', () => {
    expect(formatAda(2_000_000n)).toBe('2 ADA');
    expect(formatAda(80_196_647n)).toBe('80.196647 ADA');
    expect(formatAda(54_280_000n)).toBe('54.28 ADA');
    expect(formatAda(500_000n)).toBe('0.5 ADA');
    expect(formatAda(1_000_000_000n)).toBe('1,000 ADA');
    expect(formatAda(0n)).toBe('0 ADA');
  });
});

describe('formatUsdScaled', () => {
  it('formats a 1e6-scaled USD price with >= 2 decimals', () => {
    expect(formatUsdScaled(900_000n)).toBe('$0.90');
    expect(formatUsdScaled(1_000_000n)).toBe('$1.00');
    expect(formatUsdScaled(800_000n)).toBe('$0.80');
    expect(formatUsdScaled(1_234_567n)).toBe('$1.234567');
  });
});

describe('formatParts', () => {
  it('renders a human summary of the composed underwrite', () => {
    const pool: PoolDatum = {
      totalLiquidity: 10_000_000_000n,
      activeCoverage: 1_000_000_000n,
      lpTokenPolicy: hexToBytes('5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b'),
      protocolFeeBps: 200n,
      poolNft: hexToBytes('9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3'),
      lpSupply: 5_000_000_000n,
    };
    const parts = buildUnderwriteParts({
      bindings: {
        network: 'mainnet',
        policyValidatorHash: '1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7',
        poolValidatorHash: 'c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f',
        poolAddress: 'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr',
        poolNftPolicyId: '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3',
        poolNftAssetNameHex: '41454749535f504f4f4c5f5634',
        markerPolicyId: 'd9d24db4e4dabdc1af6a568a4ecd691b81fae891afd70eb6cabc51e7',
        teamAddress: 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3',
      },
      pool: { utxoRef: { txHash: 'aa'.repeat(32), index: 0 }, lovelace: 10_000_000_000n, datum: pool },
      insuredPkh: 'ae725d4765d908f114552f53422317cbef8c42698fc2b67e45466931',
      strikePriceScaled: 600_000n,
      spotPriceScaled: 800_000n,
      coverageLovelace: 200_000_000n,
      premiumLovelace: 80_196_647n,
      durationDays: 30,
      oraclePolicyId: '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f',
      riskClass: 'Barrier',
      nowMs: 1_750_000_000_000,
    });
    const s = formatParts(parts);
    expect(s).toContain('Barrier');
    expect(s).toContain('200 ADA');       // coverage (pool-funded)
    expect(s).toContain('80.196647 ADA'); // premium
    expect(s).toMatch(/pool-funded|coverage/i);
    expect(s).toContain('addr1wyt80hz2'); // policy script address
  });
});
