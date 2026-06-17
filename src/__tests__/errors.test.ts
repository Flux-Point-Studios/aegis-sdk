// Typed error hierarchy — partners catch by `instanceof` or stable `code`,
// never by string-matching a message.

import { describe, it, expect } from 'vitest';
import {
  AegisError,
  InputError,
  InsurabilityError,
  PoolError,
  ChainError,
} from '../errors';

describe('AegisError hierarchy', () => {
  it('carries a stable code + optional hint and is a real Error', () => {
    const e = new InsurabilityError('BELOW_FLOOR', 'premium below floor', {
      hint: 'raise the premium to at least 54.28 ADA',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AegisError);
    expect(e).toBeInstanceOf(InsurabilityError);
    expect(e.code).toBe('BELOW_FLOOR');
    expect(e.category).toBe('insurability');
    expect(e.hint).toContain('54.28');
    expect(e.message).toBe('premium below floor');
    expect(e.name).toBe('InsurabilityError');
  });

  it('subclasses map to categories', () => {
    expect(new InputError('INVALID_INPUT', 'x').category).toBe('input');
    expect(new PoolError('POOL_CANNOT_COVER', 'x').category).toBe('pool');
    expect(new ChainError('SCRIPT_FAILED', 'x').category).toBe('chain');
  });

  it('preserves an underlying cause', () => {
    const root = new Error('blockfrost 400');
    const e = new ChainError('SCRIPT_FAILED', 'phase-2 failed', { cause: root });
    expect(e.cause).toBe(root);
  });

  it('catchable by code without string matching', () => {
    try {
      throw new PoolError('CONCENTRATION_CAP', 'cap breached');
    } catch (e) {
      expect(e instanceof AegisError && e.code === 'CONCENTRATION_CAP').toBe(true);
    }
  });
});
