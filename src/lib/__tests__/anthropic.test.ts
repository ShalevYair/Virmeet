import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// callModel() constructs its own Anthropic client internally via getClient(),
// so to test its retry loop without hitting the network we replace the SDK's
// default export with a subclass whose `messages.create` we fully control,
// while still inheriting the real error classes (Anthropic.RateLimitError,
// APIConnectionTimeoutError, ...) that callModel's isRetryableError checks
// against with `instanceof`.
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic extends actual.default {
    constructor(opts?: ConstructorParameters<typeof actual.default>[0]) {
      super({ apiKey: 'test-key', ...opts });
      // @ts-expect-error — test-only override of the real messages resource.
      this.messages = { create: createMock, stream: vi.fn() };
    }
  }
  return { ...actual, default: FakeAnthropic };
});

const Anthropic = (await import('@anthropic-ai/sdk')).default;
const { callModel } = await import('../anthropic');

function fakeMessage(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const baseOptions = {
  model: 'claude-sonnet-5',
  system: [{ type: 'text' as const, text: 'sys' }],
  messages: [{ role: 'user' as const, content: 'hello' }],
  maxTokens: 100,
  apiKey: 'k',
};

describe('callModel — retry behavior (P1.2 / P3.3)', () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a timeout error and succeeds on a later attempt', async () => {
    createMock
      .mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError())
      .mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError())
      .mockResolvedValueOnce(fakeMessage('hi'));

    const promise = callModel(baseOptions);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.text).toBe('hi');
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after exhausting all retries and throws the timeout error', async () => {
    createMock.mockRejectedValue(new Anthropic.APIConnectionTimeoutError());

    const promise = callModel(baseOptions);
    promise.catch(() => {}); // silence "unhandled rejection" before we await it below
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    // 1 initial attempt + 3 retries (RETRY_DELAYS_MS has 3 entries) = 4 calls.
    expect(createMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry on abort — fails immediately', async () => {
    createMock.mockRejectedValue(new Anthropic.APIUserAbortError());

    const promise = callModel(baseOptions);
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable error (e.g. bad request)', async () => {
    createMock.mockRejectedValue(new Anthropic.BadRequestError(400, {}, 'bad request', new Headers()));

    const promise = callModel(baseOptions);
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
