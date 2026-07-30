// Virmeet — client-side helpers for user-supplied Anthropic/Gemini API keys.
// SSR-safe: every localStorage access is guarded, since this module gets
// imported from client components that Next.js also renders on the server
// during the build's prerender pass (where `window` does not exist).

export type ApiKeyProvider = 'anthropic' | 'gemini';

const STORAGE_KEYS: Record<ApiKeyProvider, string> = {
  anthropic: 'virmeet.anthropicApiKey',
  gemini: 'virmeet.geminiApiKey',
};

/** Returns the stored key for `provider`, or null if unset or running on the server. */
export function getStoredApiKey(provider: ApiKeyProvider): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEYS[provider]);
  } catch {
    // Storage disabled/unavailable (private mode, quota, etc.) — behave as unset.
    return null;
  }
}

/** Persists the key for `provider` to localStorage. No-op on the server. */
export function setStoredApiKey(provider: ApiKeyProvider, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEYS[provider], value);
  } catch {
    // Storage disabled/unavailable — silently ignore, caller's UI still reflects intent.
  }
}

/** Removes the stored key for `provider`. No-op on the server. */
export function clearStoredApiKey(provider: ApiKeyProvider): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEYS[provider]);
  } catch {
    // Storage disabled/unavailable — nothing to clear.
  }
}

/** Masks a key for display, e.g. "sk-ant-…4f2a". Never returns the full value. */
export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
