// Virmeet — thin wrapper around the Google Drive v3 REST API, called
// directly from the browser with a personal OAuth access token (see
// drive-auth.ts / drive-session.ts). No SDK — Drive's folder operations are
// simple enough that plain fetch() avoids pulling in another dependency.

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export type FetchFn = typeof fetch;

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
}

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

// ---------------------------------------------------------------------------
// File-level operations — used by engine/drive-knowledge.ts to read a
// persona's knowledge folder and keep its index file up to date.
// ---------------------------------------------------------------------------

/** Lists non-trashed, non-folder files directly under `parentId` (excludes subfolders — knowledge files only, no nesting). */
export async function listFolderFiles(
  token: string,
  parentId: string,
  fetchFn: FetchFn = fetch
): Promise<DriveFile[]> {
  const q = `trashed=false and mimeType!='${FOLDER_MIME_TYPE}' and '${parentId}' in parents`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=1000`;
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`רשימת קבצים ב-Drive נכשלה: ${await driveErrorMessage(response)}`);
  }
  const body = (await response.json()) as { files?: DriveFile[] };
  return body.files ?? [];
}

/** Finds a non-trashed, non-folder file named `name` directly under `parentId`. Returns its id, or `null` if none exists. */
export async function findFile(
  token: string,
  name: string,
  parentId: string,
  fetchFn: FetchFn = fetch
): Promise<string | null> {
  const q = `trashed=false and mimeType!='${FOLDER_MIME_TYPE}' and name='${escapeDriveQueryValue(name)}' and '${parentId}' in parents`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`חיפוש קובץ ב-Drive נכשל: ${await driveErrorMessage(response)}`);
  }
  const body = (await response.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

/** Downloads a file's raw content. */
export async function downloadFileMedia(
  token: string,
  fileId: string,
  fetchFn: FetchFn = fetch
): Promise<ArrayBuffer> {
  const response = await fetchFn(`${FILES_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`הורדת קובץ מ-Drive נכשלה: ${await driveErrorMessage(response)}`);
  }
  return response.arrayBuffer();
}

/** Downloads a file and decodes it as UTF-8 text (for small text/markdown files like the knowledge index). */
export async function downloadFileText(token: string, fileId: string, fetchFn: FetchFn = fetch): Promise<string> {
  const buffer = await downloadFileMedia(token, fileId, fetchFn);
  return new TextDecoder('utf-8').decode(buffer);
}

/** Overwrites an existing file's content (metadata — name, parents — is left untouched). */
export async function updateFileContent(
  token: string,
  fileId: string,
  content: string,
  mimeType: string,
  fetchFn: FetchFn = fetch
): Promise<void> {
  const response = await fetchFn(`${UPLOAD_URL}/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: content,
  });
  if (!response.ok) {
    throw new Error(`עדכון קובץ ב-Drive נכשל: ${await driveErrorMessage(response)}`);
  }
}

/** Creates a new, empty-metadata file record under `parentId`. Returns the new file's id — write content separately via `updateFileContent`. */
export async function createFileMetadata(
  token: string,
  name: string,
  parentId: string,
  mimeType: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const response = await fetchFn(FILES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType, parents: [parentId] }),
  });
  if (!response.ok) {
    throw new Error(`יצירת קובץ ב-Drive נכשלה: ${await driveErrorMessage(response)}`);
  }
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** Creates `name` under `parentId` with `content` if it doesn't already exist, or overwrites the existing file's content. Returns the file's id either way. */
export async function upsertTextFile(
  token: string,
  name: string,
  parentId: string,
  content: string,
  mimeType: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const existingId = await findFile(token, name, parentId, fetchFn);
  const id = existingId ?? (await createFileMetadata(token, name, parentId, mimeType, fetchFn));
  await updateFileContent(token, id, content, mimeType, fetchFn);
  return id;
}
