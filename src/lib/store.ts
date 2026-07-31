// Virmeet — storage layer (spec §2).
// JSON-on-disk store under data/. Atomic writes, per-file write locks, lazy
// seed initialization, and path-traversal-safe uploads.

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  AttachedFile,
  Meeting,
  MeetingStatus,
  MeetingType,
  OrgSettings,
  Persona,
} from './types';
import { extractText } from './extract';
import { seedOrgSettings, seedPersonas, seedMeetingTypes } from './seed';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MEETINGS_DIR = path.join(DATA_DIR, 'meetings');
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
const MEETING_TYPES_FILE = path.join(DATA_DIR, 'meeting-types.json');
const ORG_FILE = path.join(DATA_DIR, 'org.json');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.pdf', '.docx'];

// ---------------------------------------------------------------------------
// Per-file write lock — serializes writes to the same path so a meeting run
// (which writes after every phase) never races the JSON file with a
// concurrent write from the UI's polling / another request.
// ---------------------------------------------------------------------------

const writeLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(
    key,
    previous.then(() => current)
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry if nothing chained after us, to avoid unbounded growth.
    if (writeLocks.get(key) === current) {
      writeLocks.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic JSON read/write helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Read a JSON file, lazily seeding it from `seedFactory` if it doesn't exist yet. */
async function readJsonWithSeed<T>(filePath: string, seedFactory: () => T): Promise<T> {
  return withFileLock(filePath, async () => {
    if (!(await fileExists(filePath))) {
      const seed = seedFactory();
      await writeJsonAtomic(filePath, seed);
      return seed;
    }
    const raw = await fs.readFile(filePath, 'utf-8');
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt file (e.g. crash mid-write before atomic rename existed) — reseed.
      const seed = seedFactory();
      await writeJsonAtomic(filePath, seed);
      return seed;
    }
  });
}

async function writeJsonLocked(filePath: string, data: unknown): Promise<void> {
  return withFileLock(filePath, () => writeJsonAtomic(filePath, data));
}

/**
 * Read-modify-write a JSON file as a single atomic transaction under the
 * file's write lock. This is the piece that makes create/update/delete safe
 * under concurrency: listPersonas() + writeJsonLocked() as two *separate*
 * lock acquisitions would let two concurrent createPersona() calls both read
 * the same "before" array and clobber each other's write. Holding the lock
 * across the whole read -> mutate -> write sequence closes that gap.
 */
async function transact<T, R>(
  filePath: string,
  seedFactory: () => T,
  mutator: (current: T) => { next: T; result: R }
): Promise<R> {
  return withFileLock(filePath, async () => {
    let current: T;
    if (!(await fileExists(filePath))) {
      current = seedFactory();
    } else {
      const raw = await fs.readFile(filePath, 'utf-8');
      try {
        current = JSON.parse(raw) as T;
      } catch {
        current = seedFactory();
      }
    }
    const { next, result } = mutator(current);
    await writeJsonAtomic(filePath, next);
    return result;
  });
}

function nowIso(): string {
  return new Date().toISOString();
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
  model: string;
  webAccess: boolean;
  maxApiCalls: number;
  maxWebSearches: number;
  isActive?: boolean;
};

export async function listPersonas(): Promise<Persona[]> {
  return readJsonWithSeed<Persona[]>(PERSONAS_FILE, seedPersonas);
}

export async function getPersona(id: string): Promise<Persona | null> {
  const personas = await listPersonas();
  return personas.find((p) => p.id === id) ?? null;
}

export async function createPersona(input: PersonaInput): Promise<Persona> {
  return transact(PERSONAS_FILE, seedPersonas, (personas) => {
    const now = nowIso();
    const persona: Persona = {
      id: randomUUID(),
      name: input.name,
      role: input.role,
      organization: input.organization,
      color: input.color,
      prompt: input.prompt,
      model: input.model,
      webAccess: input.webAccess,
      maxApiCalls: input.maxApiCalls,
      maxWebSearches: input.maxWebSearches,
      files: [],
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    return { next: [...personas, persona], result: persona };
  });
}

export async function updatePersona(
  id: string,
  patch: Partial<PersonaInput>
): Promise<Persona | null> {
  return transact(PERSONAS_FILE, seedPersonas, (personas) => {
    const idx = personas.findIndex((p) => p.id === id);
    if (idx === -1) return { next: personas, result: null };
    const updated: Persona = {
      ...personas[idx],
      ...patch,
      id: personas[idx].id,
      files: personas[idx].files,
      createdAt: personas[idx].createdAt,
      updatedAt: nowIso(),
    };
    const next = [...personas];
    next[idx] = updated;
    return { next, result: updated };
  });
}

export async function deletePersona(id: string): Promise<boolean> {
  const removed = await transact(PERSONAS_FILE, seedPersonas, (personas) => {
    const idx = personas.findIndex((p) => p.id === id);
    if (idx === -1) return { next: personas, result: false };
    const next = personas.filter((p) => p.id !== id);
    return { next, result: true };
  });
  if (removed) {
    // Best-effort cleanup of the persona's upload directory.
    await fs.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true });
  }
  return removed;
}

/** Persist an updated files[] array on a persona (used by upload/delete file routes). */
export async function setPersonaFiles(id: string, files: AttachedFile[]): Promise<Persona | null> {
  return transact(PERSONAS_FILE, seedPersonas, (personas) => {
    const idx = personas.findIndex((p) => p.id === id);
    if (idx === -1) return { next: personas, result: null };
    const next = [...personas];
    next[idx] = { ...next[idx], files, updatedAt: nowIso() };
    return { next, result: next[idx] };
  });
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
  return readJsonWithSeed<MeetingType[]>(MEETING_TYPES_FILE, seedMeetingTypes);
}

export async function getMeetingType(id: string): Promise<MeetingType | null> {
  const types = await listMeetingTypes();
  return types.find((t) => t.id === id) ?? null;
}

export async function createMeetingType(input: MeetingTypeInput): Promise<MeetingType> {
  return transact(MEETING_TYPES_FILE, seedMeetingTypes, (types) => {
    const now = nowIso();
    const meetingType: MeetingType = {
      id: randomUUID(),
      title: input.title,
      shortDescription: input.shortDescription,
      prompt: input.prompt,
      isBuiltIn: false,
      createdAt: now,
      updatedAt: now,
    };
    return { next: [...types, meetingType], result: meetingType };
  });
}

export async function updateMeetingType(
  id: string,
  patch: Partial<MeetingTypeInput>
): Promise<MeetingType | null> {
  return transact(MEETING_TYPES_FILE, seedMeetingTypes, (types) => {
    const idx = types.findIndex((t) => t.id === id);
    if (idx === -1) return { next: types, result: null };
    const updated: MeetingType = {
      ...types[idx],
      ...patch,
      id: types[idx].id,
      isBuiltIn: types[idx].isBuiltIn,
      createdAt: types[idx].createdAt,
      updatedAt: nowIso(),
    };
    const next = [...types];
    next[idx] = updated;
    return { next, result: updated };
  });
}

/** Throws if the meeting type is built-in (built-ins are editable, not deletable). */
export async function deleteMeetingType(id: string): Promise<boolean> {
  return transact(MEETING_TYPES_FILE, seedMeetingTypes, (types) => {
    const idx = types.findIndex((t) => t.id === id);
    if (idx === -1) return { next: types, result: false };
    if (types[idx].isBuiltIn) {
      throw new Error('לא ניתן למחוק סוג פגישה מובנה');
    }
    const next = types.filter((t) => t.id !== id);
    return { next, result: true };
  });
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export async function getOrgSettings(): Promise<OrgSettings> {
  return readJsonWithSeed<OrgSettings>(ORG_FILE, seedOrgSettings);
}

export async function updateOrgSettings(
  patch: Partial<Omit<OrgSettings, 'updatedAt'>>
): Promise<OrgSettings> {
  return transact(ORG_FILE, seedOrgSettings, (current) => {
    const updated: OrgSettings = { ...current, ...patch, updatedAt: nowIso() };
    return { next: updated, result: updated };
  });
}

// ---------------------------------------------------------------------------
// Meetings — one JSON file per meeting under data/meetings/<id>.json
// ---------------------------------------------------------------------------

export type MeetingSummary = Omit<Meeting, 'transcript' | 'result'>;

export type MeetingCreateInput = {
  title: string;
  meetingTypeIds: string[];
  objective: string;
  participantIds: string[];
  files?: AttachedFile[];
  discussionRounds?: number;
};

function meetingFilePath(id: string): string {
  return path.join(MEETINGS_DIR, `${id}.json`);
}

async function listMeetingIds(): Promise<string[]> {
  await ensureDir(MEETINGS_DIR);
  const entries = await fs.readdir(MEETINGS_DIR);
  return entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp')).map((f) => f.slice(0, -'.json'.length));
}

export function listMeetings(summaryOnly: true): Promise<MeetingSummary[]>;
export function listMeetings(summaryOnly?: false): Promise<Meeting[]>;
export async function listMeetings(summaryOnly = false): Promise<Meeting[] | MeetingSummary[]> {
  const ids = await listMeetingIds();
  const meetings: Meeting[] = [];
  for (const id of ids) {
    const meeting = await getMeeting(id);
    if (meeting) meetings.push(meeting);
  }
  meetings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!summaryOnly) return meetings;
  return meetings.map(({ transcript: _transcript, result: _result, ...rest }) => rest);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const filePath = meetingFilePath(id);
  if (!(await fileExists(filePath))) return null;
  const raw = await fs.readFile(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as Meeting;
  } catch {
    return null;
  }
}

export async function createMeeting(input: MeetingCreateInput): Promise<Meeting> {
  const now = nowIso();
  const meeting: Meeting = {
    id: randomUUID(),
    title: input.title,
    meetingTypeIds: input.meetingTypeIds,
    objective: input.objective,
    participantIds: input.participantIds,
    files: input.files ?? [],
    discussionRounds: input.discussionRounds ?? 2,
    status: 'draft' as MeetingStatus,
    transcript: [],
    result: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiCalls: 0, costUsd: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await writeJsonLocked(meetingFilePath(meeting.id), meeting);
  return meeting;
}

/**
 * Shallow-merges `patch` onto the stored meeting and persists it. This is the
 * function the meeting engine calls after every phase, so it goes through the
 * same per-file lock as everything else touching this path.
 */
export async function updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting | null> {
  const filePath = meetingFilePath(id);
  return withFileLock(filePath, async () => {
    if (!(await fileExists(filePath))) return null;
    const raw = await fs.readFile(filePath, 'utf-8');
    let current: Meeting;
    try {
      current = JSON.parse(raw) as Meeting;
    } catch {
      return null;
    }
    const updated: Meeting = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(filePath, updated);
    return updated;
  });
}

/** Persist an updated files[] array on a meeting's shared background files. */
export async function setMeetingFiles(id: string, files: AttachedFile[]): Promise<Meeting | null> {
  return updateMeeting(id, { files });
}

export async function deleteMeeting(id: string): Promise<boolean> {
  const filePath = meetingFilePath(id);
  if (!(await fileExists(filePath))) return false;
  await fs.rm(filePath, { force: true });
  await fs.rm(`${filePath}.tmp`, { force: true }).catch(() => undefined);
  return true;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** Strip path separators, `..`, and control characters from a user-supplied filename. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/\.\./g, '');
  // eslint-disable-next-line no-control-regex
  let sanitized = base.replace(/[\x00-\x1f\x7f]/g, '');
  sanitized = sanitized.replace(/[/\\?%*:|"<>]/g, '_').trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') sanitized = 'file';
  return sanitized;
}

function sanitizeOwnerId(ownerId: string): string {
  const cleaned = ownerId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned) throw new Error('מזהה בעלים לא תקין');
  return cleaned;
}

/** Web-standard `File`-like shape — matches both the DOM `File` type and Node's undici `File`. */
export interface UploadableFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function saveUpload(ownerId: string, file: UploadableFile): Promise<AttachedFile> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('הקובץ גדול מדי — הגודל המקסימלי המותר הוא 10MB');
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`סוג קובץ לא נתמך: ${ext || '(ללא סיומת)'}. הסיומות המותרות: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }

  const safeOwnerId = sanitizeOwnerId(ownerId);
  const fileId = randomUUID();
  const sanitizedName = sanitizeFilename(file.name);
  const storedRelPath = path.join('uploads', safeOwnerId, `${fileId}__${sanitizedName}`);
  const fullPath = path.join(DATA_DIR, storedRelPath);

  // Path-traversal guard: the resolved path must remain inside data/uploads/.
  const resolvedUploadsRoot = path.resolve(UPLOADS_DIR) + path.sep;
  const resolvedFullPath = path.resolve(fullPath);
  if (!resolvedFullPath.startsWith(resolvedUploadsRoot)) {
    throw new Error('נתיב קובץ לא חוקי');
  }

  await ensureDir(path.dirname(fullPath));
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(fullPath, buffer);

  const extraction = await extractText(fullPath, ext);

  return {
    id: fileId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    storedPath: storedRelPath,
    extractedText: extraction.text,
    extractionError: extraction.error,
    addedAt: nowIso(),
  };
}

export async function deleteUpload(ownerId: string, fileId: string): Promise<void> {
  const safeOwnerId = sanitizeOwnerId(ownerId);
  const dir = path.join(UPLOADS_DIR, safeOwnerId);
  const resolvedUploadsRoot = path.resolve(UPLOADS_DIR) + path.sep;
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedUploadsRoot)) {
    throw new Error('נתיב קובץ לא חוקי');
  }
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const match = entries.find((e) => e.startsWith(`${fileId}__`));
  if (!match) return;
  await fs.rm(path.join(dir, match), { force: true });
}

// Exposed for tests / advanced callers that need the raw path constants.
export const _internal = {
  DATA_DIR,
  UPLOADS_DIR,
  MEETINGS_DIR,
};
