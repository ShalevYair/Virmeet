// Virmeet — thin server-side wrapper around @google/genai (spec §0, §4).
// Server-only. Never import this from client components.

import { ApiError, BlockedReason, FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { GenerateContentConfig, GenerateContentResponse } from '@google/genai';

/**
 * Builds a Gemini client. `explicitApiKey` — when present — is a key the
 * browser sent on this request (see the run route) and takes priority over
 * GEMINI_API_KEY. A fresh client is built on every call (construction is
 * cheap — it does not open a connection) so a user-supplied key is never
 * cached or logged in a shared module-level singleton.
 * Throws a Hebrew error if neither source has a key.
 */
function getClient(explicitApiKey?: string): GoogleGenAI {
  const apiKey = explicitApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'מפתח ה-API של Gemini לא הוגדר. אפשר להגדיר GEMINI_API_KEY בקובץ .env.local בצד השרת, או להזין מפתח אישי במסך ההגדרות (Settings) בדפדפן.'
    );
  }
  return new GoogleGenAI({ apiKey });
}

export interface SystemBlock {
  type: 'text';
  text: string;
}

export interface CallModelMessage {
  role: 'user';
  content: string;
}

export interface WebSearchOptions {
  maxUses: number;
}

export interface CallModelOptions {
  model: string;
  system: SystemBlock[];
  messages: CallModelMessage[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  webSearch?: WebSearchOptions;
  /** JSON schema for structured output. Must set additionalProperties:false and required on every field. */
  jsonSchema?: Record<string, unknown>;
  /** Optional key sent by the browser for this run, preferred over GEMINI_API_KEY. Never logged or persisted. */
  apiKey?: string;
}

export interface CallModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface WebSearchQuery {
  query: string;
}

export interface CallModelResult {
  text: string;
  webSearches: WebSearchQuery[];
  usage: CallModelUsage;
  refused: boolean;
}

const RETRY_DELAYS_MS = [2000, 4000, 8000];
// max_tokens above this must use streaming to avoid hitting HTTP timeouts.
const STREAMING_THRESHOLD = 16000;

// Gemini's Google Search tool cannot be combined with response_schema /
// response_json_schema in the same call — when both are requested we keep
// the search tool and fall back to a plain-JSON instruction instead of
// enforced structured output. The runner already tolerates malformed JSON
// from a single persona call (it emits a system error line and continues),
// so this degrades gracefully rather than guaranteeing an API error.
const JSON_FALLBACK_INSTRUCTION =
  '\n\n(השב אך ורק בפורמט JSON תקין, בהתאם למבנה השדות שהתבקשת עליו למעלה — בלי טקסט נוסף, בלי גדרות קוד (```).)';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 429 || err.status >= 500;
  }
  // No HTTP status means the request never reached the API (network/DNS/etc).
  return true;
}

const THINKING_LEVEL_BY_EFFORT: Record<NonNullable<CallModelOptions['effort']>, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

interface BuiltRequest {
  contents: string;
  config: GenerateContentConfig;
}

function buildRequest(opts: CallModelOptions): BuiltRequest {
  const systemInstruction = opts.system.map((block) => block.text).join('\n\n');
  const useSearch = Boolean(opts.webSearch);
  const useSchema = Boolean(opts.jsonSchema) && !useSearch;

  let contents = opts.messages.map((m) => m.content).join('\n\n');
  if (opts.jsonSchema && useSearch) {
    contents += JSON_FALLBACK_INSTRUCTION;
  }

  const config: GenerateContentConfig = {
    systemInstruction,
    maxOutputTokens: opts.maxTokens,
  };

  if (opts.effort) {
    config.thinkingConfig = { thinkingLevel: THINKING_LEVEL_BY_EFFORT[opts.effort] };
  }
  if (useSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = opts.jsonSchema;
  }
  if (useSearch) {
    config.tools = [{ googleSearch: {} }];
  }

  return { contents, config };
}

// Finish reasons that mean the model declined to produce usable text — as
// opposed to STOP/MAX_TOKENS, where text (partial, for MAX_TOKENS) exists.
const REFUSAL_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.LANGUAGE,
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.UNEXPECTED_TOOL_CALL,
]);

function usageFrom(usage: GenerateContentResponse['usageMetadata']): CallModelUsage {
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
  };
}

function extractResult(response: GenerateContentResponse, textOverride?: string): CallModelResult {
  const text = textOverride ?? response.text ?? '';
  const candidate = response.candidates?.[0];
  const blockReason = response.promptFeedback?.blockReason;
  const finishReason = candidate?.finishReason;
  const refused =
    blockReason === BlockedReason.SAFETY ||
    blockReason === BlockedReason.OTHER ||
    blockReason === BlockedReason.BLOCKLIST ||
    blockReason === BlockedReason.PROHIBITED_CONTENT ||
    (!text && finishReason != null && REFUSAL_FINISH_REASONS.has(finishReason));

  const webSearches: WebSearchQuery[] = (candidate?.groundingMetadata?.webSearchQueries ?? []).map((query) => ({
    query,
  }));

  return { text, webSearches, usage: usageFrom(response.usageMetadata), refused };
}

async function callNonStreaming(
  client: GoogleGenAI,
  model: string,
  contents: string,
  config: GenerateContentConfig
): Promise<CallModelResult> {
  const response = await client.models.generateContent({ model, contents, config });
  return extractResult(response);
}

async function callStreaming(
  client: GoogleGenAI,
  model: string,
  contents: string,
  config: GenerateContentConfig
): Promise<CallModelResult> {
  const stream = await client.models.generateContentStream({ model, contents, config });

  let text = '';
  let last: GenerateContentResponse | undefined;
  const webSearchQueries = new Set<string>();

  for await (const chunk of stream) {
    text += chunk.text ?? '';
    last = chunk;
    for (const q of chunk.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? []) {
      webSearchQueries.add(q);
    }
  }

  const result = last ? extractResult(last, text) : { text, webSearches: [], usage: usageFrom(undefined), refused: false };
  return { ...result, webSearches: Array.from(webSearchQueries, (query) => ({ query })) };
}

/**
 * Single logical model call with retry (3 attempts, backoff 2s/4s/8s), retrying
 * only on rate-limit / server / connection errors. Streams automatically when
 * max_tokens exceeds the safe non-streaming threshold.
 */
export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  const client = getClient(opts.apiKey);
  const { contents, config } = buildRequest(opts);
  const useStreaming = opts.maxTokens > STREAMING_THRESHOLD;

  let attempt = 0;
  // attempt 0 = first try, then up to RETRY_DELAYS_MS.length retries.
  for (;;) {
    try {
      return useStreaming
        ? await callStreaming(client, opts.model, contents, config)
        : await callNonStreaming(client, opts.model, contents, config);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err)) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}
