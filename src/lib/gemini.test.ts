import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallModelOptions } from './llm-types';

const baseOpts: Omit<CallModelOptions, 'signal'> = {
  model: 'gemini-3.1-pro-preview',
  system: [{ type: 'text', text: 'system prompt' }],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  apiKey: 'test-key',
};

afterEach(() => {
  vi.doUnmock('@google/genai');
  vi.resetModules();
});

describe('gemini.ts callModel — abort during retry backoff', () => {
  it('rejects promptly instead of waiting out the full 2s/4s/8s backoff once the signal aborts', async () => {
    class FakeApiError extends Error {
      status: number;
      constructor(options: { message: string; status: number }) {
        super(options.message);
        this.status = options.status;
      }
    }
    const generateContent = vi.fn().mockRejectedValue(new FakeApiError({ message: 'rate limited', status: 429 }));

    vi.doMock('@google/genai', () => ({
      ApiError: FakeApiError,
      GoogleGenAI: class {
        models = { generateContent };
        constructor() {}
      },
    }));

    const { callModel } = await import('./gemini');

    const controller = new AbortController();
    controller.abort(); // aborted before the first attempt even starts

    const start = Date.now();
    await expect(callModel({ ...baseOpts, signal: controller.signal })).rejects.toThrow('rate limited');
    const elapsedMs = Date.now() - start;

    // Un-aborted, exhausting all 3 retries waits 2000+4000+8000 = 14000ms.
    // Aborted, every sleep() call resolves immediately — this must stay
    // far below that, not just faster.
    expect(elapsedMs).toBeLessThan(1000);
    expect(generateContent).toHaveBeenCalledTimes(4); // 1 initial attempt + 3 retries
  });

  it('passes the signal through to the SDK call itself, not just the retry sleep', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: 'ok',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {},
    });

    vi.doMock('@google/genai', () => ({
      ApiError: class extends Error {},
      GoogleGenAI: class {
        models = { generateContent };
        constructor() {}
      },
    }));

    const { callModel } = await import('./gemini');

    const controller = new AbortController();
    await callModel({ ...baseOpts, signal: controller.signal });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const [request] = generateContent.mock.calls[0];
    expect((request.config as { abortSignal?: AbortSignal }).abortSignal).toBe(controller.signal);
  });
});
