// Virmeet — thin wrapper around the Google Drive v3 REST API, called
// directly from the browser with a personal OAuth access token (see
// drive-auth.ts / drive-session.ts). No SDK — Drive's folder operations are
// simple enough that plain fetch() avoids pulling in another dependency.

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export type FetchFn = typeof fetch;

/** Escapes `'` and `\` so a name is safe to interpolate into a Drive `q` filter. */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Body wasn't JSON (or empty) — fall through to the status-only message.
  }
  return `${response.status} ${response.statusText}`;
}

/** Finds a non-trashed folder named `name` directly under `parentId`. Returns its id, or `null` if none exists. */
export async function findFolder(
  token: string,
  name: string,
  parentId: string,
  fetchFn: FetchFn = fetch
): Promise<string | null> {
  const q = `mimeType='${FOLDER_MIME_TYPE}' and trashed=false and name='${escapeDriveQueryValue(name)}' and '${parentId}' in parents`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`חיפוש תיקייה ב-Drive נכשל: ${await driveErrorMessage(response)}`);
  }
  const body = (await response.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

/** Creates a folder named `name` under `parentId`. Returns the new folder's id. */
export async function createFolder(
  token: string,
  name: string,
  parentId: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const response = await fetchFn(FILES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] }),
  });
  if (!response.ok) {
    throw new Error(`יצירת תיקייה ב-Drive נכשלה: ${await driveErrorMessage(response)}`);
  }
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** Idempotent: reuses an existing folder named `name` under `parentId`, or creates one. */
export async function ensureFolder(
  token: string,
  name: string,
  parentId: string,
  fetchFn: FetchFn = fetch
): Promise<{ id: string; created: boolean }> {
  const existing = await findFolder(token, name, parentId, fetchFn);
  if (existing) return { id: existing, created: false };
  const id = await createFolder(token, name, parentId, fetchFn);
  return { id, created: true };
}

export const VIRMEET_ROOT_FOLDER_NAME = 'VIRMEET';

/** Ensures the top-level `VIRMEET` folder exists directly under the user's Drive root. */
export async function ensureVirmeetRootFolder(
  token: string,
  fetchFn: FetchFn = fetch
): Promise<{ id: string; created: boolean }> {
  return ensureFolder(token, VIRMEET_ROOT_FOLDER_NAME, 'root', fetchFn);
}

/** Ensures a persona's knowledge folder exists under the `VIRMEET` root, named after the persona. */
export async function ensurePersonaFolder(
  token: string,
  rootFolderId: string,
  personaName: string,
  fetchFn: FetchFn = fetch
): Promise<{ id: string; created: boolean }> {
  return ensureFolder(token, personaName, rootFolderId, fetchFn);
}
