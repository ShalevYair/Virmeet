// Virmeet — export/import a persona to/from a standalone JSON file (spec §5.3).
// Export downloads exactly the seed JSON shape (see seed-schemas.ts) so the
// same file can be committed to public/seed/personas/ or re-imported later.
// Import is validated with zod before anything is written to IndexedDB.

import { createPersona, getPersona, putPersonaRaw } from './store';
import { ensureSeedLoaded } from './seed-loader';
import type { AttachedFile, Persona } from './types';
import { personaSeedFileSchema, type PersonaSeed } from './seed-schemas';

/** Splits a persona's files into seed-style `files` (nothing — there's no seed path once it's a live persona) and `embeddedFiles` (everything, as text). */
function toPersonaSeed(persona: Persona): PersonaSeed {
  const embeddedFiles = persona.files.map((f) => ({ name: f.name, text: f.extractedText }));
  return {
    id: persona.id,
    name: persona.name,
    role: persona.role,
    organization: persona.organization,
    color: persona.color,
    prompt: persona.prompt,
    webAccess: persona.webAccess,
    maxApiCalls: persona.maxApiCalls,
    maxWebSearches: persona.maxWebSearches,
    isActive: persona.isActive,
    embeddedFiles: embeddedFiles.length > 0 ? embeddedFiles : undefined,
  };
}

/** Downloads `persona` as `<id>.json`. Revokes the object URL immediately after triggering the download. */
export function exportPersonaToFile(persona: Persona): void {
  const seed = toPersonaSeed(persona);
  const blob = new Blob([JSON.stringify(seed, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${persona.id}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export type ImportConflictResolution = 'overwrite' | 'copy';

export interface ImportPersonaResult {
  imported: Persona[];
  /** Ids that already existed and were skipped — caller should ask the user how to resolve these and re-call with a resolution. */
  conflicts: PersonaSeed[];
}

async function seedToPersona(seed: PersonaSeed, overrideId?: string): Promise<Persona> {
  const now = new Date().toISOString();
  const files: AttachedFile[] = (seed.embeddedFiles ?? []).map((f) => ({
    id: crypto.randomUUID(),
    name: f.name,
    mimeType: 'text/plain',
    sizeBytes: f.text.length,
    storedPath: '',
    extractedText: f.text,
    addedAt: now,
  }));

  if (overrideId) {
    // "Import as a copy" — goes through createPersona so it gets a fresh id,
    // then we attach the files (createPersona always starts with files: []).
    const created = await createPersona({
      name: `${seed.name} (עותק)`,
      role: seed.role,
      organization: seed.organization,
      color: seed.color,
      prompt: seed.prompt,
      webAccess: seed.webAccess,
      maxApiCalls: seed.maxApiCalls,
      maxWebSearches: seed.maxWebSearches,
      isActive: seed.isActive ?? true,
    });
    const persona: Persona = { ...created, files };
    await putPersonaRaw(persona);
    return persona;
  }

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
  return persona;
}

/**
 * Parses and imports a persona JSON file (a single persona or an array of
 * them, per spec §5.3). Personas whose `id` already exists are reported back
 * as `conflicts` instead of being written — call `resolveImportConflicts`
 * with the user's choice to finish importing them.
 */
export async function importPersonaFile(fileText: string): Promise<ImportPersonaResult> {
  await ensureSeedLoaded();

  let raw: unknown;
  try {
    raw = JSON.parse(fileText);
  } catch {
    throw new Error('הקובץ אינו JSON תקין.');
  }

  const parsed = personaSeedFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('מבנה קובץ הפרסונה אינו תקין — בדקו שהשדות הנדרשים קיימים ומהסוג הנכון.');
  }
  const seeds = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

  const imported: Persona[] = [];
  const conflicts: PersonaSeed[] = [];
  for (const seed of seeds) {
    if (await getPersona(seed.id)) {
      conflicts.push(seed);
      continue;
    }
    imported.push(await seedToPersona(seed));
  }

  return { imported, conflicts };
}

/** Finishes importing personas that conflicted with an existing id, per the user's chosen resolution. */
export async function resolveImportConflicts(
  conflicts: PersonaSeed[],
  resolution: ImportConflictResolution
): Promise<Persona[]> {
  const results: Persona[] = [];
  for (const seed of conflicts) {
    if (resolution === 'overwrite') {
      results.push(await seedToPersona(seed));
    } else {
      results.push(await seedToPersona(seed, seed.id));
    }
  }
  return results;
}
