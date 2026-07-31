// Virmeet — model pricing table + cost estimation helpers (spec P2.1).
//
// Prices last verified 2026-07-31 against Anthropic's official pricing via
// the claude-api skill. USD per 1,000,000 tokens. Claude Sonnet 5 is
// currently running its introductory price (through 2026-08-31) — after that
// it reverts to the standard $3 / $15 row noted below; update this table when
// that happens. Cache-read tokens are billed at ~10% of the input price.
// Virmeet doesn't track cache-write tokens separately, so they aren't priced
// here — they're a small, one-time cost per cached prefix.

import { AVAILABLE_MODELS, AvailableModel } from './types';

export interface ModelPriceUsdPerMTok {
  input: number;
  output: number;
}

const CACHE_READ_DISCOUNT = 0.1;

export const MODEL_PRICING_USD_PER_MTOK: Record<AvailableModel, ModelPriceUsdPerMTok> = {
  'claude-sonnet-5': { input: 2.0, output: 10.0 }, // intro price through 2026-08-31; standard is $3 / $15
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

function priceFor(model: string): ModelPriceUsdPerMTok {
  return MODEL_PRICING_USD_PER_MTOK[model as AvailableModel] ?? MODEL_PRICING_USD_PER_MTOK['claude-sonnet-5'];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Fraction (any positive scale — normalized internally) of usage attributable to each model. */
export type ModelMix = Partial<Record<AvailableModel, number>>;

/** Blends `usage` across `modelMix` into an estimated USD cost. Not exact — order-of-magnitude only. */
export function estimateCostUsd(usage: UsageTotals, modelMix: ModelMix): number {
  const entries = Object.entries(modelMix) as [AvailableModel, number][];
  const totalWeight = entries.reduce((sum, [, w]) => sum + (w ?? 0), 0);
  if (totalWeight <= 0) return 0;

  let cost = 0;
  for (const [model, weight] of entries) {
    const share = (weight ?? 0) / totalWeight;
    const price = priceFor(model);
    cost +=
      (share * usage.inputTokens * price.input) / 1_000_000 +
      (share * usage.outputTokens * price.output) / 1_000_000 +
      (share * usage.cacheReadTokens * price.input * CACHE_READ_DISCOUNT) / 1_000_000;
  }
  return cost;
}

/**
 * Exact cost from a meeting transcript: each entry is priced against the
 * model its own speaker actually used (looked up via `modelBySpeakerId`, e.g.
 * personaId -> persona.model, plus 'facilitator' -> MODELS.facilitator).
 * Entries without `usage` (system lines, refusals) contribute nothing.
 */
export function estimateTranscriptCostUsd(
  entries: { speakerId: string; usage?: UsageTotals }[],
  modelBySpeakerId: Map<string, string>
): number {
  let cost = 0;
  for (const entry of entries) {
    if (!entry.usage) continue;
    const model = modelBySpeakerId.get(entry.speakerId) ?? 'claude-sonnet-5';
    const price = priceFor(model);
    cost +=
      (entry.usage.inputTokens * price.input) / 1_000_000 +
      (entry.usage.outputTokens * price.output) / 1_000_000 +
      (entry.usage.cacheReadTokens * price.input * CACHE_READ_DISCOUNT) / 1_000_000;
  }
  return cost;
}

// -----------------------------------------------------------------------
// Pre-run estimate (spec P2.1 §3): "1 + participants + participants*rounds + 2"
// model calls — 1 opening + participants prep calls + participants*rounds
// discussion calls (all on each persona's own model) + 2 facilitator calls
// (convergence + extraction).
// -----------------------------------------------------------------------

const ROUGH_PERSONA_CALL_TOKENS = { input: 3000, output: 400 };
const ROUGH_FACILITATOR_CALL_TOKENS = { input: 6000, output: 700 };

export interface PreRunEstimate {
  apiCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Rough pre-run estimate for the "new meeting" wizard. `personaModels` has
 * one entry per selected participant (their configured model); `facilitatorModel`
 * is MODELS.facilitator. Intentionally imprecise — enough to tell whether a
 * run costs cents or dollars, not to forecast the exact bill.
 */
export function estimatePreRunUsage(
  personaModels: string[],
  facilitatorModel: string,
  discussionRounds: number
): PreRunEstimate {
  const callsPerPersona = 1 + discussionRounds; // 1 prep call + one per discussion round
  const facilitatorCalls = 3; // opening + convergence + extraction
  const apiCalls = personaModels.length * callsPerPersona + facilitatorCalls;

  const modelMix: ModelMix = {};
  let inputTokens = 0;
  let outputTokens = 0;

  for (const model of personaModels) {
    const key = (AVAILABLE_MODELS as readonly string[]).includes(model)
      ? (model as AvailableModel)
      : 'claude-sonnet-5';
    modelMix[key] = (modelMix[key] ?? 0) + callsPerPersona;
    inputTokens += callsPerPersona * ROUGH_PERSONA_CALL_TOKENS.input;
    outputTokens += callsPerPersona * ROUGH_PERSONA_CALL_TOKENS.output;
  }

  const facilitatorKey = (AVAILABLE_MODELS as readonly string[]).includes(facilitatorModel)
    ? (facilitatorModel as AvailableModel)
    : 'claude-opus-5';
  modelMix[facilitatorKey] = (modelMix[facilitatorKey] ?? 0) + facilitatorCalls;
  inputTokens += facilitatorCalls * ROUGH_FACILITATOR_CALL_TOKENS.input;
  outputTokens += facilitatorCalls * ROUGH_FACILITATOR_CALL_TOKENS.output;

  const estimatedCostUsd = estimateCostUsd({ inputTokens, outputTokens, cacheReadTokens: 0 }, modelMix);

  return { apiCalls, estimatedInputTokens: inputTokens, estimatedOutputTokens: outputTokens, estimatedCostUsd };
}
