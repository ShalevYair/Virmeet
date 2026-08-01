// Virmeet — Google Identity Services (GIS) token-client wrapper for Drive
// OAuth, entirely in-browser (no server, no redirect back-end — matches the
// rest of the app's trust model). Lazily loads Google's script only when a
// connection is actually requested, same spirit as extract.ts's dynamic
// `import('mammoth')`.

import { clearDriveAccessToken, getDriveAccessToken, setDriveAccessToken } from './drive-session';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * The app's own OAuth Client ID — a public identifier, not a per-user
 * secret (unlike the Gemini API key). Baked in at build time via
 * NEXT_PUBLIC_DRIVE_CLIENT_ID (see .env.local for local dev, and
 * .github/workflows/deploy-pages.yml for the deployed site), so every
 * visitor just clicks "connect" and authorizes with their own Google
 * account — nobody pastes a Client ID into the app itself.
 */
export const DRIVE_CLIENT_ID = process.env.NEXT_PUBLIC_DRIVE_CLIENT_ID || '';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }) => TokenClient;
          revoke: (token: string, callback: () => void) => void;
        };
      };
    };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisLoadPromise: Promise<void> | null = null;

/** Loads the Google Identity Services script exactly once per page load. */
function loadGis(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('חיבור ל-Drive זמין רק בדפדפן.'));
  }
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoadPromise = null;
      reject(new Error('טעינת ספריית ההזדהות של Google נכשלה. בדקו את החיבור לרשת ונסו שוב.'));
    };
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

/**
 * Opens Google's consent popup and requests a Drive access token
 * (`DRIVE_SCOPE`, full read/write — see the plan's scope decision). Resolves
 * once the token is granted and stored via drive-session.ts; rejects with a
 * Hebrew message on denial or failure. Never throws synchronously.
 */
export async function requestDriveAccessToken(clientId: string): Promise<void> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new Error('יש להזין Client ID לפני החיבור.');
  }
  await loadGis();

  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: trimmed,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description || response.error || 'ההתחברות ל-Drive נכשלה או בוטלה.'
            )
          );
          return;
        }
        setDriveAccessToken(response.access_token, response.expires_in ?? 3600);
        resolve();
      },
    });
    client.requestAccessToken();
  });
}

/** Revokes the current session's token with Google and clears it locally. No-op if not connected. */
export async function revokeDriveAccess(): Promise<void> {
  const token = getDriveAccessToken();
  clearDriveAccessToken();
  if (!token || typeof window === 'undefined' || !window.google?.accounts?.oauth2) return;
  await new Promise<void>((resolve) => {
    window.google!.accounts.oauth2.revoke(token, () => resolve());
  });
}
