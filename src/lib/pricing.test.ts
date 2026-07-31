import { describe, expect, it } from 'vitest';
import { estimateCallCostUsd, formatUsd } from './pricing';

describe('estimateCallCostUsd', () => {
  it('prices a plain sonnet call by input/output tokens', () => {
    const cost = estimateCallCostUsd('claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cost).toBeCloseTo(3.0 + 15.0, 5);
  });

  it('discounts cache reads and surcharges cache writes relative to plain input', () => {
    const base = estimateCallCostUsd('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    });
    expect(base).toBeCloseTo(5.0 * 0.1, 5);

    const write = estimateCallCostUsd('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    expect(write).toBeCloseTo(5.0 * 1.25, 5);
  });

  it('falls back to the sonnet rate for an unknown model id', () => {
    const known = estimateCallCostUsd('claude-sonnet-5', {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const unknown = estimateCallCostUsd('some-future-model', {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(unknown).toBeCloseTo(known, 10);
  });
});

describe('formatUsd', () => {
  it('formats ordinary amounts to two decimals', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(1)).toBe('$1.00');
  });

  it('shows a floor label for amounts under a cent', () => {
    expect(formatUsd(0.001)).toBe('<$0.01');
  });

  it('shows $0.00 for exactly zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
});
