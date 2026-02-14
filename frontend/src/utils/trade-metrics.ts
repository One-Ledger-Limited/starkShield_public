function parsePositiveNumber(input: string): number | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function computeMinExchangeRate(amountIn: string, minAmountOut: string): number | null {
  const input = parsePositiveNumber(amountIn);
  const output = parsePositiveNumber(minAmountOut);
  if (input === null || output === null) return null;
  return output / input;
}

// Only meaningful when tokenIn and tokenOut are the same unit.
export function computeImpliedSlippagePercentSameToken(amountIn: string, minAmountOut: string): number | null {
  const input = parsePositiveNumber(amountIn);
  const output = parsePositiveNumber(minAmountOut);
  if (input === null || output === null) return null;

  const raw = (1 - output / input) * 100;
  if (!Number.isFinite(raw)) return null;
  // Slippage tolerance should not be negative (minOut > amountIn is user error in same-token case).
  return Math.max(0, raw);
}

export function formatPercent(value: number): string {
  return value.toFixed(2);
}

export function formatRate(value: number): string {
  // Keep it readable without exploding decimals.
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(6).replace(/\.?0+$/, '');
  return value.toFixed(8).replace(/\.?0+$/, '');
}

