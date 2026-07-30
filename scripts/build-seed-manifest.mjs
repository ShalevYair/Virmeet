#!/usr/bin/env node
// Virmeet — generates public/seed/manifest.json by scanning public/seed/.
// The browser can't list a directory over fetch(), so this manifest is the
// only way the client learns which persona/meeting-type/shared-file JSON
// exists. Runs on every `npm run dev` / `npm run build` (see package.json
// predev/prebuild) so a JSON file added through the GitHub web UI shows up
// after the next deploy with zero manual manifest editing.
//
// Fails the build (non-zero exit) if any seed JSON file doesn't parse —
// better to fail loudly here than ship a broken manifest.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_DIR = path.join(ROOT, 'public', 'seed');
const PERSONAS_DIR = path.join(SEED_DIR, 'personas');
const MEETING_TYPES_DIR = path.join(SEED_DIR, 'meeting-types');
const FILES_DIR = path.join(SEED_DIR, 'files');
const ORG_SETTINGS_FILE = path.join(SEED_DIR, 'org-settings.json');
const MANIFEST_FILE = path.join(SEED_DIR, 'manifest.json');

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
}

/** Parses every JSON file in `dir` to make sure it's valid — throws with the
 * offending filename on failure, so a broken commit fails the build instead
 * of shipping a broken site. */
function validateJsonFiles(dir, relDir) {
  for (const name of listJsonFiles(dir)) {
    const filePath = path.join(dir, name);
    const raw = fs.readFileSync(filePath, 'utf-8');
    try {
      JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `קובץ ה-seed "${relDir}/${name}" אינו JSON תקין: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function listSharedFiles() {
  if (!fs.existsSync(FILES_DIR)) return [];
  return fs
    .readdirSync(FILES_DIR)
    .filter((name) => name.toLowerCase() !== 'readme.md')
    .sort();
}

function hashContents(paths) {
  const hash = createHash('sha256');
  for (const p of paths) {
    hash.update(p);
    hash.update(fs.readFileSync(p));
  }
  return hash.digest('hex').slice(0, 16);
}

function main() {
  validateJsonFiles(PERSONAS_DIR, 'personas');
  validateJsonFiles(MEETING_TYPES_DIR, 'meeting-types');
  if (fs.existsSync(ORG_SETTINGS_FILE)) {
    try {
      JSON.parse(fs.readFileSync(ORG_SETTINGS_FILE, 'utf-8'));
    } catch (err) {
      throw new Error(`קובץ ה-seed "org-settings.json" אינו JSON תקין: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const personas = listJsonFiles(PERSONAS_DIR).map((name) => `personas/${name}`);
  const meetingTypes = listJsonFiles(MEETING_TYPES_DIR).map((name) => `meeting-types/${name}`);
  const sharedFiles = listSharedFiles().map((name) => `files/${name}`);

  const allTrackedPaths = [
    ...(fs.existsSync(ORG_SETTINGS_FILE) ? [ORG_SETTINGS_FILE] : []),
    ...personas.map((p) => path.join(SEED_DIR, p)),
    ...meetingTypes.map((p) => path.join(SEED_DIR, p)),
    ...sharedFiles.map((p) => path.join(SEED_DIR, p)),
  ].sort();

  const manifest = {
    version: hashContents(allTrackedPaths),
    generatedAt: new Date().toISOString(),
    orgSettings: fs.existsSync(ORG_SETTINGS_FILE) ? 'org-settings.json' : null,
    personas,
    meetingTypes,
    sharedFiles,
  };

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `[build-seed-manifest] ${personas.length} personas, ${meetingTypes.length} meeting types, ` +
      `${sharedFiles.length} shared files — version ${manifest.version}`
  );
}

main();
