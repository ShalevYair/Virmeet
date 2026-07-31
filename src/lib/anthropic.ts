// Virmeet — thin server-side wrapper around @anthropic-ai/sdk (spec §0, §4).
// Server-only. Never import this from client components.

import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

/**
 * Lazily constructs the Anthropic client. `explicitApiKey` — when present —
 * is a key the browser sent on this request (see the run route) and takes
 * priority over ANTHROPIC_API_KEY. It is never cached or logged: a fresh,
 * one-off client is built for it on every call so a user-supplied key never
 * lingers in the shared module-level singleton or leaks across requests.
 * Throws a Hebrew error if neither source has a key.
 */
export function getClient(explicitApiKey?: string): Anthropic {
  if (explicitApiKey) {
    // We own retries ourselves (see callModel) — disable the SDK's built-in
    // retry so backoff timing stays deterministic and under our control.
    return new Anthropic({ apiKey: explicitApiKey, maxRetries: 0 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'מפתח ה-API של Anthropic לא הוגדר. אפשר להגדיר אותו בקובץ .env.local בצד השרת, או להזין מפתח אישי במסך ההגדרות (Settings) בדפדפן.'
    );
  }
  if (!client) {
    client = new Anthropic({ maxRetries: 0 });
  }
  return client;
}

export interface SystemBlock {
  type: 'text';
  text: string;
}

export type CallModelMessage = Anthropic.MessageParam;

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
  /** Optional key sent by the browser for this run, preferred over ANTHROPIC_API_KEY. Never logged or persisted. */
  apiKey?: string;
  /** Aborts the request (including one already in flight) when the meeting is cancelled. */
  signal?: AbortSignal;
  /** Milliseconds before the request is aborted and retried. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 180_000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError || // includes APIConnectionTimeoutError
    err instanceof Anthropic.APIConnectionTimeoutError
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === 'AbortError');
}

/** Builds the `system` array with cache_control on the LAST block only (spec §0). */
function buildSystemParam(system: SystemBlock[]): Anthropic.TextBlockParam[] {
  return system.map((block, idx): Anthropic.TextBlockParam => {
    const isLast = idx === system.length - 1;
    return isLast
      ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: block.text };
  });
}

function buildParams(opts: CallModelOptions): Anthropic.MessageCreateParamsNonStreaming {
  const outputConfig: Anthropic.OutputConfig = {};
  if (opts.effort) outputConfig.effort = opts.effort;
  if (opts.jsonSchema) {
    outputConfig.format = { type: 'json_schema', schema: opts.jsonSchema };
  }

  const tools: Anthropic.ToolUnion[] = [];
  if (opts.webSearch) {
    tools.push({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: opts.webSearch.maxUses,
    });
  }

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: buildSystemParam(opts.system),
    messages: opts.messages,
    // Adaptive thinking — never budget_tokens, never temperature/top_p/top_k.
    thinking: { type: 'adaptive' },
  };
  if (Object.keys(outputConfig).length > 0) {
    params.output_config = outputConfig;
  }
  if (tools.length > 0) {
    params.tools = tools;
  }
  return params;
}

function extractResult(message: Anthropic.Message): CallModelResult {
  // Handle refusal BEFORE reading content (spec §0).
  if (message.stop_reason === 'refusal') {
    return {
      text: '',
      webSearches: [],
      usage: usageFrom(message.usage),
      refused: true,
    };
  }

  let text = '';
  const webSearches: WebSearchQuery[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      const input = block.input as Record<string, unknown> | undefined;
      const query = typeof input?.query === 'string' ? input.query : undefined;
      if (query) webSearches.push({ query });
    }
  }

  return { text, webSearches, usage: usageFrom(message.usage), refused: false };
}

function usageFrom(usage: Anthropic.Usage): CallModelUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Single logical model call with retry (3 attempts, backoff 2s/4s/8s), retrying
 * only on RateLimitError / InternalServerError / connection errors. Streams
 * automatically when max_tokens exceeds the safe non-streaming threshold.
 */
export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  const anthropic = getClient(opts.apiKey);
  const params = buildParams(opts);
  const useStreaming = opts.maxTokens > STREAMING_THRESHOLD;
  const requestOptions = { signal: opts.signal, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };

  let attempt = 0;
  // attempt 0 = first try, then up to RETRY_DELAYS_MS.length retries.
  for (;;) {
    try {
      const message = useStreaming
        ? await anthropic.messages.stream(params, requestOptions).finalMessage()
        : await anthropic.messages.create(params, requestOptions);
      return extractResult(message);
    } catch (err) {
      if (isAbortError(err) || attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err)) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}
