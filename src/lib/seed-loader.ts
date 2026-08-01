// Virmeet — loads public/seed/*.json into IndexedDB on first run, and on
// demand via the "טען מחדש מהריפו" button in Settings (spec §5.2).
//
// The critical rule: automatic loading NEVER overwrites data the user has
// already edited. It only adds what's missing (matched by the seed JSON's
// own stable `id`). Only an explicit force-reload overwrites existing
// seed-sourced entries — and even then, only entries whose id appears in the
// manifest; anything the user created themselves is left untouched.
//
// A missing or corrupt manifest must never crash the app: on failure this
// returns a Hebrew warning and leaves IndexedDB exactly as it was (possibly
// empty, on a first-ever visit).

import { seedUrl } from './base-path';
import { extensionOf, extractText } from './extract';
import {
  getKv,
  getMeetingType,
  getPersona,
  putMeetingTypeRaw,
  putPersonaRaw,
  setKv,
} from './store';
import type { AttachedFile, MeetingType, OrgSettings, Persona } from './types';
import {
  meetingTypeSeedSchema,
  orgSettingsSeedSchema,
  personaSeedSchema,
  seedManifestSchema,
  type PersonaSeed,
  type SeedManifest,
} from './seed-schemas';

export interface SeedLoadResult {
  status: 'skipped' | 'loaded' | 'error';
  warning?: string;
  personaCount?: number;
  meetingTypeCount?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rejects any path that could escape public/seed/ (no leading slash, no `..` segment). */
function isSafeSeedRelativePath(relPath: string): boolean {
  if (relPath.startsWith('/')) return false;
  return !relPath.split('/').some((segment) => segment === '..');
}

async function fetchJson<T>(relPath: string): Promise<T> {
  const res = await fetch(seedUrl(relPath), { cache: 'no-store' });
  if (!res.ok) throw new Error(`הבקשה ל-${relPath} נכשלה (${res.status})`);
  return res.json() as Promise<T>;
}

function placeholderAttachedFile(relPath: string, extractionError: string): AttachedFile {
  return {
    id: crypto.randomUUID(),
    name: relPath.split('/').pop() ?? relPath,
    mimeType: 'application/octet-stream',
    sizeBytes: 0,
    storedPath: relPath,
    extractedText: '',
    extractionError,
    addedAt: new Date(0).toISOString(),
  };
}

async function fetchSeedFile(relPath: string): Promise<AttachedFile> {
  if (!isSafeSeedRelativePath(relPath)) {
    return placeholderAttachedFile(relPath, 'נתיב קובץ לא חוקי (מכיל ".." או מתחיל ב-"/")');
  }
  const fileName = relPath.split('/').pop() ?? relPath;
  let res: Response;
  try {
    res = await fetch(seedUrl(`seed/${relPath}`));
  } catch (err) {
    return placeholderAttachedFile(relPath, `טעינת הקובץ נכשלה: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    return placeholderAttachedFile(relPath, `הקובץ לא נמצא (${res.status})`);
  }
  const blob = await res.blob();
  const extraction = await extractText(blob, extensionOf(fileName));
  return {
    id: crypto.randomUUID(),
    name: fileName,
    mimeType: blob.type || 'application/octet-stream',
    sizeBytes: blob.size,
    storedPath: relPath,
    extractedText: extraction.text,
    extractionError: extraction.error,
    addedAt: new Date(0).toISOString(),
  };
}

function embeddedToAttachedFile(name: string, text: string): AttachedFile {
  return {
    id: crypto.randomUUID(),
    name,
    mimeType: 'text/plain',
    sizeBytes: text.length,
    storedPath: '',
    extractedText: text,
    addedAt: new Date(0).toISOString(),
  };
}

export async function buildAttachedFilesFromSeed(seed: PersonaSeed): Promise<AttachedFile[]> {
  const fromPaths = await Promise.all((seed.files ?? []).map(fetchSeedFile));
  const embedded = (seed.embeddedFiles ?? []).map((f) => embeddedToAttachedFile(f.name, f.text));
  return [...fromPaths, ...embedded];
}

async function loadPersona(relPath: string, force: boolean): Promise<boolean> {
  const raw = await fetchJson<unknown>(`seed/${relPath}`);
  const seed = personaSeedSchema.parse(raw);
  if (!force && (await getPersona(seed.id))) return false;

  const files = await buildAttachedFilesFromSeed(seed);
  const now = new Date(0).toISOString();
  const persona: Persona = {
    id: seed.id,
    name: seed.name,
    role: seed.role,
    organization: seed.organization,
    color: seed.color,
    prompt: seed.prompt,
    webAccess: seed.webAccess,
    maxApiCalls: seed.maxApiCalls,
    maxWebSearches: seed.maxWebSearches,
    files,
    isActive: seed.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await putPersonaRaw(persona);
  return true;
}

async function loadMeetingType(relPath: string, force: boolean): Promise<boolean> {
  const raw = await fetchJson<unknown>(`seed/${relPath}`);
  const seed = meetingTypeSeedSchema.parse(raw);
  if (!force && (await getMeetingType(seed.id))) return false;

  const now = new Date(0).toISOString();
  const meetingType: MeetingType = {
    id: seed.id,
    title: seed.title,
    shortDescription: seed.shortDescription,
    prompt: seed.prompt,
    isBuiltIn: seed.isBuiltIn ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await putMeetingTypeRaw(meetingType);
  return true;
}

async function loadOrgSettings(relPath: string, force: boolean): Promise<void> {
  const existing = await getKv<OrgSettings>('orgSettings');
  if (existing && !force) return;
  const raw = await fetchJson<unknown>(`seed/${relPath}`);
  const seed = orgSettingsSeedSchema.parse(raw);
  await setKv('orgSettings', { ...seed, updatedAt: new Date(0).toISOString() });
}

// Every store read anywhere in the app (see api-client.ts's `run()`) awaits
// this same cached promise before touching IndexedDB, so a page's first
// render can never race ahead of seeding and see an empty store that fills
// in a moment later with nothing telling the page to re-render. Whichever
// caller (SeedBoot, or the first api-client call) arrives first triggers the
// one real fetch; everyone else just awaits it.
let cachedLoad: Promise<SeedLoadResult> | null = null;

export function ensureSeedLoaded(opts: { force?: boolean } = {}): Promise<SeedLoadResult> {
  if (opts.force || !cachedLoad) {
    cachedLoad = loadSeed(opts);
  }
  return cachedLoad;
}

/**
 * Loads public/seed/ into IndexedDB. On a normal (non-forced) call this is a
 * no-op once `kv.seedVersion` already matches the manifest's version — so it
 * is safe to call on every app boot. Pass `force: true` (from the "טען מחדש
 * מהריפו" button) to overwrite existing seed-sourced entries.
 */
async function loadSeed(opts: { force?: boolean } = {}): Promise<SeedLoadResult> {
  const force = opts.force ?? false;

  let manifest: SeedManifest;
  try {
    const raw = await fetchJson<unknown>('seed/manifest.json');
    manifest = seedManifestSchema.parse(raw);
  } catch (err) {
    return {
      status: 'error',
      warning:
        `טעינת נתוני ה-seed מהריפו נכשלה (${errorMessage(err)}). האפליקציה ` +
        'תמשיך לעבוד עם הנתונים המקומיים הקיימים בדפדפן זה בלבד.',
    };
  }

  if (!force) {
    const currentVersion = await getKv<string>('seedVersion');
    if (currentVersion === manifest.version) {
      return { status: 'skipped' };
    }
  }

  let personaCount = 0;
  for (const relPath of manifest.personas) {
    try {
      if (await loadPersona(relPath, force)) personaCount++;
    } catch (err) {
      console.warn(`[seed-loader] נכשל בטעינת פרסונת seed מ-${relPath}:`, err);
    }
  }

  let meetingTypeCount = 0;
  for (const relPath of manifest.meetingTypes) {
    try {
      if (await loadMeetingType(relPath, force)) meetingTypeCount++;
    } catch (err) {
      console.warn(`[seed-loader] נכשל בטעינת סוג פגישה מ-${relPath}:`, err);
    }
  }

  if (manifest.orgSettings) {
    try {
      await loadOrgSettings(manifest.orgSettings, force);
    } catch (err) {
      console.warn('[seed-loader] נכשל בטעינת הגדרות הארגון:', err);
    }
  }

  await setKv('seedVersion', manifest.version);
  return { status: 'loaded', personaCount, meetingTypeCount };
}
