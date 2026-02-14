import { describe, expect, it } from 'vitest';
import {
  computeImpliedSlippagePercentSameToken,
  computeMinExchangeRate,
  formatPercent,
  formatRate,
} from './trade-metrics';

describe('trade-metrics', () => {
  it('computes min exchange rate', () => {
    expect(computeMinExchangeRate('1', '2000')).toBe(2000);
    expect(computeMinExchangeRate('2', '1')).toBe(0.5);
  });

  it('returns null for invalid numbers', () => {
    expect(computeMinExchangeRate('0', '1')).toBeNull();
    expect(computeMinExchangeRate('1', '0')).toBeNull();
    expect(computeMinExchangeRate('abc', '1')).toBeNull();
  });

  it('computes implied slippage for same token and clamps negative to 0', () => {
    expect(computeImpliedSlippagePercentSameToken('100', '99')).toBeCloseTo(1, 10);
    expect(computeImpliedSlippagePercentSameToken('100', '100')).toBeCloseTo(0, 10);
    expect(computeImpliedSlippagePercentSameToken('100', '101')).toBeCloseTo(0, 10);
  });

  it('formats values', () => {
    expect(formatPercent(1)).toBe('1.00');
    expect(formatRate(2000)).toBe('2000.00');
    expect(formatRate(1.5)).toBe('1.5');
    expect(formatRate(0.5)).toBe('0.5');
  });
});

