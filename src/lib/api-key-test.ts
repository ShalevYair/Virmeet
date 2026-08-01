// Virmeet — validates a personal Gemini API key against the real provider, so
// the Settings screen can tell the user "this key works" before they start a
// meeting with it. Dynamically imports the Gemini SDK so it isn't pulled into
// every page's bundle — only Settings, and only once the user clicks "test".

export type TestApiKeyResult = { ok: true } | { ok: false; message: string };

export async function testApiKey(apiKey: string): Promise<TestApiKeyResult> {
  const { testApiKey: test } = await import('./gemini');
  return test(apiKey);
}
