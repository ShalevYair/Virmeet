// Virmeet — thin wrapper around @google/genai, called directly from the
// browser, mirroring anthropic.ts's callModel() shape so llm.ts can dispatch
// between the two providers without the engine caring which one is behind a
// given model id. There is no server component anymore — every key comes
// from the caller, which reads it out of localStorage (see api-key.ts).

import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';
import type { CallModelOptions, CallModelResult, CallModelUsage, SystemBlock } from './llm-types';

/**
 * Constructs a Gemini client for `apiKey`. Mirrors anthropic.ts#getClient: a
 * fresh client is built on every call so a key never lingers beyond the call
 * that needed it. Throws a Hebrew error if no key was supplied.
 */
export function getClient(apiKey?: string): GoogleGenAI {
  if (!apiKey) {
    throw new Error(
      'מפתח ה-API של Gemini לא הוגדר. יש להזין מפתח אישי במסך ההגדרות (Settings).'
    );
  }
  return new GoogleGenAI({ apiKey });
}

const RETRY_DELAYS_MS = [2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof GeminiApiError) {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

function buildSystemInstruction(system: SystemBlock[]): string {
  return system.map((block) => block.text).join('\n\n');
}

/** Gemini 3's thinking_level only has three settings; effort maps down onto them. */
function mapEffortToThinkingLevel(effort: CallModelOptions['effort']): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high'; // 'high' | 'xhigh' | 'max' | undefined
}

function usageFrom(usage: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined): CallModelUsage {
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
  };
}

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

/**
 * Single logical model call with retry (3 attempts, backoff 2s/4s/8s), retrying
 * only on 429 / 5xx from the Gemini API. Same CallModelOptions/CallModelResult
 * contract as anthropic.ts#callModel.
 */
export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  const ai = getClient(opts.apiKey);

  const config: Record<string, unknown> = {
    maxOutputTokens: opts.maxTokens,
    systemInstruction: buildSystemInstruction(opts.system),
    thinkingConfig: { thinkingLevel: mapEffortToThinkingLevel(opts.effort) },
  };
  if (opts.jsonSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = opts.jsonSchema;
  }
  if (opts.webSearch) {
    config.tools = [{ googleSearch: {} }];
  }

  const contents = opts.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let attempt = 0;
  for (;;) {
    try {
      const response = await ai.models.generateContent({ model: opts.model, contents, config });

      const promptBlockReason = response.promptFeedback?.blockReason;
      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason;
      if (promptBlockReason || (finishReason && BLOCKED_FINISH_REASONS.has(finishReason))) {
        return { text: '', webSearches: [], usage: usageFrom(response.usageMetadata), refused: true };
      }

      const webSearches = (candidate?.groundingMetadata?.webSearchQueries ?? []).map((query) => ({ query }));
      return {
        text: response.text ?? '',
        webSearches,
        usage: usageFrom(response.usageMetadata),
        refused: false,
      };
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err)) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}
