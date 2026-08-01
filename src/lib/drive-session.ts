// Virmeet — in-memory (never localStorage) holder for the current Drive
// OAuth access token. Unlike the Gemini API key, this is deliberately not
// persisted: access tokens are short-lived (~1h) and re-consenting is quick,
// so there's no real benefit to persisting one and a real downside (a stale
// or leaked token living in localStorage). Module-level state — not React
// state — so both the Settings UI and, from Stage 3 onward, the meeting
// engine can read the same live session within this tab.

let accessToken: string | null = null;
let expiresAt = 0; // epoch ms

/** Stores a freshly-granted token. `expiresInSeconds` comes straight from Google's token response. */
export function setDriveAccessToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  // Shave 60s off the real expiry so a call that starts just before expiry
  // doesn't get rejected mid-flight by Google before this module notices.
  expiresAt = Date.now() + Math.max(0, expiresInSeconds - 60) * 1000;
}

/** Returns the current token, or `null` if never granted or expired. */
export function getDriveAccessToken(): string | null {
  if (!accessToken || Date.now() >= expiresAt) return null;
  return accessToken;
}

export function isDriveConnected(): boolean {
  return getDriveAccessToken() !== null;
}

export function clearDriveAccessToken(): void {
  accessToken = null;
  expiresAt = 0;
}
