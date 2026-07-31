import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallModelOptions } from './llm-types';

const baseOpts: Omit<CallModelOptions, 'signal'> = {
  model: 'claude-sonnet-5',
  system: [{ type: 'text', text: 'system prompt' }],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  apiKey: 'test-key',
};

afterEach(() => {
  vi.doUnmock('@anthropic-ai/sdk');
  vi.resetModules();
});

describe('anthropic.ts callModel — abort during retry backoff', () => {
  it('rejects promptly instead of waiting out the full 2s/4s/8s backoff once the signal aborts', async () => {
    class RateLimitError extends Error {}
    const create = vi.fn().mockRejectedValue(new RateLimitError('rate limited'));

    vi.doMock('@anthropic-ai/sdk', () => {
      class FakeAnthropic {
        static RateLimitError = RateLimitError;
        static InternalServerError = class extends Error {};
        static APIConnectionError = class extends Error {};
        static AuthenticationError = class extends Error {};
        messages = { create, stream: vi.fn() };
        constructor() {}
      }
      return { default: FakeAnthropic };
    });

    const { callModel } = await import('./anthropic');

    const controller = new AbortController();
    controller.abort(); // aborted before the first attempt even starts

    const start = Date.now();
    await expect(callModel({ ...baseOpts, signal: controller.signal })).rejects.toThrow('rate limited');
    const elapsedMs = Date.now() - start;

    // Un-aborted, exhausting all 3 retries waits 2000+4000+8000 = 14000ms.
    // Aborted, every sleep() call resolves immediately — this must stay
    // far below that, not just faster.
    expect(elapsedMs).toBeLessThan(1000);
    expect(create).toHaveBeenCalledTimes(4); // 1 initial attempt + 3 retries
  });

  it('passes the signal through to the SDK call itself, not just the retry sleep', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    vi.doMock('@anthropic-ai/sdk', () => {
      class FakeAnthropic {
        static RateLimitError = class extends Error {};
        static InternalServerError = class extends Error {};
        static APIConnectionError = class extends Error {};
        static AuthenticationError = class extends Error {};
        messages = { create, stream: vi.fn() };
        constructor() {}
      }
      return { default: FakeAnthropic };
    });

    const { callModel } = await import('./anthropic');

    const controller = new AbortController();
    await callModel({ ...baseOpts, signal: controller.signal });

    expect(create).toHaveBeenCalledTimes(1);
    const [, requestOptions] = create.mock.calls[0];
    expect(requestOptions).toMatchObject({ signal: controller.signal });
  });
});
