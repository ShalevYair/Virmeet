// Virmeet — model pricing snapshot for estimating meeting cost (C1 in WORKPLAN.md).
// Prices are a point-in-time snapshot and can drift — every place that shows a
// number derived from this file must label it as an *estimate*, never a bill.

import { CallModelUsage } from './anthropic';

interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelRate> = {
  'claude-opus-5': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  'claude-sonnet-5': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
};

// Reads from the prompt cache cost ~0.1x the input rate; writes (5-minute
// ephemeral TTL, the only kind Virmeet uses) cost ~1.25x. See A1 in
// WORKPLAN.md — don't switch to the 1h TTL without updating this to 2x.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const FALLBACK_RATE = PRICING['claude-sonnet-5'];

/** Estimated USD cost of a single model call. Unknown model ids fall back to the sonnet rate. */
export function estimateCallCostUsd(model: string, usage: CallModelUsage): number {
  const rate = PRICING[model] ?? FALLBACK_RATE;
  const inputCost =
    (usage.inputTokens * rate.inputPerMillion +
      usage.cacheCreationTokens * rate.inputPerMillion * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * rate.inputPerMillion * CACHE_READ_MULTIPLIER) /
    1_000_000;
  const outputCost = (usage.outputTokens * rate.outputPerMillion) / 1_000_000;
  return inputCost + outputCost;
}

/** Renders a USD estimate for display, e.g. "$0.42" or "<$0.01" for tiny amounts. */
export function formatUsd(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.01) return '<$0.01';
  return `$${amountUsd.toFixed(2)}`;
}
