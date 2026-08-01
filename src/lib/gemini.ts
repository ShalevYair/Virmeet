// Virmeet — thin wrapper around @google/genai, called directly from the
// browser. There is no server component — the key comes from the caller,
// which reads it out of localStorage (see api-key.ts).

import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';
import type { CallModelOptions, CallModelResult, CallModelUsage, SystemBlock } from './llm-types';

/**
 * Constructs a Gemini client for `apiKey`. A fresh client is built on every
 * call so a key never lingers beyond the call that needed it. Throws a
 * Hebrew error if no key was supplied.
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

/** Resolves after `ms`, or immediately once `signal` aborts — never makes a cancelled run wait out a full retry backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof GeminiApiError) {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

export type TestApiKeyResult = { ok: true } | { ok: false; message: string };

/**
 * Validates a Gemini API key with the cheapest possible real request —
 * listing models, which needs authentication but performs no generation and
 * costs no tokens. Never throws.
 */
export async function testApiKey(apiKey: string): Promise<TestApiKeyResult> {
  try {
    const ai = getClient(apiKey);
    await ai.models.list({ config: { pageSize: 1 } });
    return { ok: true };
  } catch (err) {
    if (err instanceof GeminiApiError && (err.status === 400 || err.status === 401 || err.status === 403)) {
      return { ok: false, message: `המפתח אינו תקין — Gemini דחה את בקשת האימות (${err.status}).` };
    }
    return {
      ok: false,
      message: `הבדיקה נכשלה: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
    // Gemini's context caching is implicit — there's no separate cache-write
    // request or token count to report. Always 0, intentionally, not a gap.
    cacheWriteTokens: 0,
  };
}

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

/**
 * Single logical model call with retry (3 attempts, backoff 2s/4s/8s), retrying
 * only on 429 / 5xx from the Gemini API.
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
    // Verified against Gemini API docs: Gemini 3 models support combining
    // structured output with built-in tools including Grounding with Google
    // Search in the same request — this is not a blocked combination.
    config.tools = [{ googleSearch: {} }];
  }
  if (opts.signal) {
    config.abortSignal = opts.signal;
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
        return { text: '', webSearches: [], usage: usageFrom(response.usageMetadata), refused: true, truncated: false };
      }

      const webSearches = (candidate?.groundingMetadata?.webSearchQueries ?? []).map((query) => ({ query }));
      const text = response.text ?? '';
      // An empty response that wasn't blocked is its own failure mode: thinking
      // can consume the entire token budget before any output text is produced,
      // and finishReason isn't guaranteed to say MAX_TOKENS when that happens —
      // treat it as truncated too so the caller never tries to JSON.parse('').
      const truncated = finishReason === 'MAX_TOKENS' || text === '';
      return {
        text,
        webSearches,
        usage: usageFrom(response.usageMetadata),
        refused: false,
        truncated,
      };
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err)) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt], opts.signal);
      attempt += 1;
    }
  }
}
