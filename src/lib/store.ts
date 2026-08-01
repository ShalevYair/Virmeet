// Virmeet — storage layer, browser-only via IndexedDB (spec §5.1).
// Same function signatures as the old fs-backed store, so the meeting engine
// (engine/runner.ts) and every page needs no changes beyond this file.
// Every function here is browser-only — it throws if called during the
// build's server-side prerender (no `indexedDB` global there); pages only
// call these from useEffect/event handlers, which never run during prerender.

import { openDB, type IDBPDatabase } from 'idb';
import { AttachedFile, AvailableModel, Meeting, MeetingStatus, MeetingType, OrgSettings, Persona } from './types';
import { extensionOf, extractText } from './extract';

const DB_NAME = 'virmeet';
const DB_VERSION = 1;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.pdf', '.docx'];

const BLANK_ORG_SETTINGS: OrgSettings = {
  organizationName: '',
  description: '',
  constraints: '',
  updatedAt: new Date(0).toISOString(),
};

interface KvRow {
  key: string;
  value: unknown;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB אינו זמין בסביבה הזו (ריצה בצד השרת?).'));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('personas')) db.createObjectStore('personas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meetingTypes')) db.createObjectStore('meetingTypes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// kv — small generic key/value store, used for org settings + seed version
// (see seed-loader.ts). Exposed for seed-loader; not meant for other callers.
// ---------------------------------------------------------------------------

export async function getKv<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const row = (await db.get('kv', key)) as KvRow | undefined;
  return row?.value as T | undefined;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('kv', { key, value });
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export type PersonaInput = {
  name: string;
  role: string;
  organization: string;
  color: string;
  prompt: string;
  webAccess: boolean;
  maxApiCalls: number;
  maxWebSearches: number;
  isActive?: boolean;
};

export async function listPersonas(): Promise<Persona[]> {
  const db = await getDb();
  return db.getAll('personas');
}

export async function getPersona(id: string): Promise<Persona | null> {
  const db = await getDb();
  return (await db.get('personas', id)) ?? null;
}

export async function createPersona(input: PersonaInput): Promise<Persona> {
  const db = await getDb();
  const now = nowIso();
  const persona: Persona = {
    id: newId(),
    name: input.name,
    role: input.role,
    organization: input.organization,
    color: input.color,
    prompt: input.prompt,
    webAccess: input.webAccess,
    maxApiCalls: input.maxApiCalls,
    maxWebSearches: input.maxWebSearches,
    files: [],
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await db.put('personas', persona);
  return persona;
}

export async function updatePersona(id: string, patch: Partial<PersonaInput>): Promise<Persona | null> {
  const db = await getDb();
  const current: Persona | undefined = await db.get('personas', id);
  if (!current) return null;
  const updated: Persona = {
    ...current,
    ...patch,
    id: current.id,
    files: current.files,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  await db.put('personas', updated);
  return updated;
}

export async function deletePersona(id: string): Promise<boolean> {
  const db = await getDb();
  const existing = await db.get('personas', id);
  if (!existing) return false;
  await db.delete('personas', id);
  return true;
}

/** Persist an updated files[] array on a persona (used by upload/delete file flows). */
export async function setPersonaFiles(id: string, files: AttachedFile[]): Promise<Persona | null> {
  const db = await getDb();
  const current: Persona | undefined = await db.get('personas', id);
  if (!current) return null;
  const updated: Persona = { ...current, files, updatedAt: nowIso() };
  await db.put('personas', updated);
  return updated;
}

/** Writes a persona verbatim (used only by seed-loader.ts, which supplies its own stable id). */
export async function putPersonaRaw(persona: Persona): Promise<void> {
  const db = await getDb();
  await db.put('personas', persona);
}

// ---------------------------------------------------------------------------
// Meeting types
// ---------------------------------------------------------------------------

export type MeetingTypeInput = {
  title: string;
  shortDescription: string;
  prompt: string;
};

export async function listMeetingTypes(): Promise<MeetingType[]> {
  const db = await getDb();
  return db.getAll('meetingTypes');
}

export async function getMeetingType(id: string): Promise<MeetingType | null> {
  const db = await getDb();
  return (await db.get('meetingTypes', id)) ?? null;
}

export async function createMeetingType(input: MeetingTypeInput): Promise<MeetingType> {
  const db = await getDb();
  const now = nowIso();
  const meetingType: MeetingType = {
    id: newId(),
    title: input.title,
    shortDescription: input.shortDescription,
    prompt: input.prompt,
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.put('meetingTypes', meetingType);
  return meetingType;
}

export async function updateMeetingType(
  id: string,
  patch: Partial<MeetingTypeInput>
): Promise<MeetingType | null> {
  const db = await getDb();
  const current: MeetingType | undefined = await db.get('meetingTypes', id);
  if (!current) return null;
  const updated: MeetingType = {
    ...current,
    ...patch,
    id: current.id,
    isBuiltIn: current.isBuiltIn,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  await db.put('meetingTypes', updated);
  return updated;
}

/** Throws if the meeting type is built-in (built-ins are editable, not deletable). */
export async function deleteMeetingType(id: string): Promise<boolean> {
  const db = await getDb();
  const current: MeetingType | undefined = await db.get('meetingTypes', id);
  if (!current) return false;
  if (current.isBuiltIn) {
    throw new Error('לא ניתן למחוק סוג פגישה מובנה');
  }
  await db.delete('meetingTypes', id);
  return true;
}

/** Writes a meeting type verbatim (used only by seed-loader.ts, which supplies its own stable id). */
export async function putMeetingTypeRaw(meetingType: MeetingType): Promise<void> {
  const db = await getDb();
  await db.put('meetingTypes', meetingType);
}

// ---------------------------------------------------------------------------
// Org settings — a single record under the kv store.
// ---------------------------------------------------------------------------

export async function getOrgSettings(): Promise<OrgSettings> {
  const existing = await getKv<OrgSettings>('orgSettings');
  return existing ?? BLANK_ORG_SETTINGS;
}

export async function updateOrgSettings(
  patch: Partial<Omit<OrgSettings, 'updatedAt'>>
): Promise<OrgSettings> {
  const current = await getOrgSettings();
  const updated: OrgSettings = { ...current, ...patch, updatedAt: nowIso() };
  await setKv('orgSettings', updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export type MeetingSummary = Omit<Meeting, 'transcript' | 'result' | 'files'>;

export type MeetingCreateInput = {
  title: string;
  meetingTypeIds: string[];
  objective: string;
  participantIds: string[];
  creatorParticipates?: boolean;
  model: AvailableModel;
  files?: AttachedFile[];
  discussionRounds?: number;
};

export function listMeetings(summaryOnly: true): Promise<MeetingSummary[]>;
export function listMeetings(summaryOnly?: false): Promise<Meeting[]>;
export async function listMeetings(summaryOnly = false): Promise<Meeting[] | MeetingSummary[]> {
  const db = await getDb();
  const meetings: Meeting[] = await db.getAll('meetings');
  meetings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!summaryOnly) return meetings;
  return meetings.map(({ transcript: _transcript, result: _result, files: _files, ...rest }) => rest);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const db = await getDb();
  return (await db.get('meetings', id)) ?? null;
}

export async function createMeeting(input: MeetingCreateInput): Promise<Meeting> {
  const db = await getDb();
  const now = nowIso();
  const meeting: Meeting = {
    id: newId(),
    title: input.title,
    meetingTypeIds: input.meetingTypeIds,
    objective: input.objective,
    participantIds: input.participantIds,
    creatorParticipates: input.creatorParticipates ?? false,
    model: input.model,
    files: input.files ?? [],
    discussionRounds: input.discussionRounds ?? 2,
    status: 'draft' as MeetingStatus,
    transcript: [],
    result: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await db.put('meetings', meeting);
  return meeting;
}

/**
 * Shallow-merges `patch` onto the stored meeting and persists it. This is the
 * function the meeting engine calls after every phase.
 */
export async function updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting | null> {
  const db = await getDb();
  const current: Meeting | undefined = await db.get('meetings', id);
  if (!current) return null;
  const updated: Meeting = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  await db.put('meetings', updated);
  return updated;
}

/** Persist an updated files[] array on a meeting's shared background files. */
export async function setMeetingFiles(id: string, files: AttachedFile[]): Promise<Meeting | null> {
  return updateMeeting(id, { files });
}

export async function deleteMeeting(id: string): Promise<boolean> {
  const db = await getDb();
  const existing = await db.get('meetings', id);
  if (!existing) return false;
  await db.delete('meetings', id);
  return true;
}

// ---------------------------------------------------------------------------
// Uploads — extraction only now; there is no disk to write to. The resulting
// AttachedFile is stored inline on the persona/meeting record in IndexedDB.
// ---------------------------------------------------------------------------

/** Never throws for extraction failures (see extract.ts); throws only on validation (size/type). */
export async function saveUpload(file: File): Promise<AttachedFile> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('הקובץ גדול מדי — הגודל המקסימלי המותר הוא 10MB');
  }
  const ext = extensionOf(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`סוג קובץ לא נתמך: ${ext || '(ללא סיומת)'}. הסיומות המותרות: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }

  const extraction = await extractText(file, ext);

  return {
    id: newId(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    storedPath: '',
    extractedText: extraction.text,
    extractionError: extraction.error,
    addedAt: nowIso(),
  };
}
