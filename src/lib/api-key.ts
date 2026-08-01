// Virmeet — client-side helpers for a user-supplied Gemini API key.
// SSR-safe: every localStorage access is guarded, since this module gets
// imported from client components that Next.js also renders on the server
// during the build's prerender pass (where `window` does not exist).

const STORAGE_KEY = 'virmeet.geminiApiKey';

/** Returns the stored key, or null if unset or running on the server. */
export function getStoredApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage disabled/unavailable (private mode, quota, etc.) — behave as unset.
    return null;
  }
}

/** Persists the key to localStorage. No-op on the server. */
export function setStoredApiKey(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage disabled/unavailable — silently ignore, caller's UI still reflects intent.
  }
}

/** Removes the stored key. No-op on the server. */
export function clearStoredApiKey(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled/unavailable — nothing to clear.
  }
}

/** Masks a key for display, e.g. "AIzaSyC…4f2a". Never returns the full value. */
export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
