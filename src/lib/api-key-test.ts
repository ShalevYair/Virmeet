// Virmeet — validates a personal API key against the real provider, so the
// Settings screen can tell the user "this key works" before they start a
// meeting with it. Dynamically imports the provider SDK so the (fairly
// heavy) Anthropic/Gemini clients aren't pulled into every page's bundle —
// only Settings, and only once the user actually clicks the test button.

import type { ApiKeyProvider } from './api-key';

export type TestApiKeyResult = { ok: true } | { ok: false; message: string };

export async function testApiKey(provider: ApiKeyProvider, apiKey: string): Promise<TestApiKeyResult> {
  if (provider === 'anthropic') {
    const { testApiKey: test } = await import('./anthropic');
    return test(apiKey);
  }
  const { testApiKey: test } = await import('./gemini');
  return test(apiKey);
}
