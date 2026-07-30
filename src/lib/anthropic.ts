// Virmeet — thin wrapper around @anthropic-ai/sdk, called directly from the
// browser (spec §0, §4, §2.4 of docs/PLAN-static-github-pages.md). There is
// no server component anymore — every key comes from the caller, which reads
// it out of localStorage (see api-key.ts).

import Anthropic from '@anthropic-ai/sdk';
import type { CallModelOptions, CallModelResult, CallModelUsage, SystemBlock, WebSearchQuery } from './llm-types';

/**
 * Constructs an Anthropic client for `apiKey`. A fresh client is built on
 * every call rather than cached as a module-level singleton, so a key never
 * lingers beyond the call that needed it. Throws a Hebrew error if no key was
 * supplied. `dangerouslyAllowBrowser` is required because this SDK call now
 * runs in the browser, not on a server — see the security note in README.md.
 */
export function getClient(apiKey?: string): Anthropic {
  if (!apiKey) {
    throw new Error(
      'מפתח ה-API של Anthropic לא הוגדר. יש להזין מפתח אישי במסך ההגדרות (Settings).'
    );
  }
  // We own retries ourselves (see callModel) — disable the SDK's built-in
  // retry so backoff timing stays deterministic and under our control.
  return new Anthropic({ apiKey, maxRetries: 0, dangerouslyAllowBrowser: true });
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
    err instanceof Anthropic.APIConnectionError
  );
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

  let attempt = 0;
  // attempt 0 = first try, then up to RETRY_DELAYS_MS.length retries.
  for (;;) {
    try {
      const message = useStreaming
        ? await anthropic.messages.stream(params).finalMessage()
        : await anthropic.messages.create(params);
      return extractResult(message);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err)) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}
