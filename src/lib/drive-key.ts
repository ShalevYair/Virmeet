// Virmeet — client-side helpers for a user-supplied Google Drive OAuth
// Client ID. SSR-safe, same shape as api-key.ts. A Client ID is a public
// identifier (not a secret) — it's meant to be embedded in browser apps —
// so storing it in localStorage carries none of the risk a real API key
// would.

const STORAGE_KEY = 'virmeet.driveClientId';

/** Returns the stored Client ID, or null if unset or running on the server. */
export function getStoredDriveClientId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persists the Client ID to localStorage. No-op on the server. */
export function setStoredDriveClientId(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage disabled/unavailable — silently ignore, caller's UI still reflects intent.
  }
}

/** Removes the stored Client ID. No-op on the server. */
export function clearStoredDriveClientId(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled/unavailable — nothing to clear.
  }
}
