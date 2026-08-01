// Virmeet — refreshes one persona's Drive knowledge-folder index at the
// start of a meeting run (spec: staged Drive-backed persona knowledge,
// stage 3). Lists the folder, diffs each file's Drive `modifiedTime`
// against what's already recorded in a small `.md` index file living in
// that same folder, and only re-reads + re-summarizes files that are new or
// changed — unchanged files reuse their existing summary, so a folder that
// hasn't changed between meetings costs nothing beyond a single listing
// call. Deliberately uses the cheapest model tier regardless of what the
// meeting itself is running on (see DRIVE_INDEX_MODEL) — this is
// housekeeping, not part of the simulated discussion.
//
// This stage only maintains the index; nothing reads it into a persona's
// prompt yet (that's the next stage).

import { downloadFileMedia, downloadFileText, findFile, listFolderFiles, upsertTextFile, type FetchFn } from '../drive';
import { extensionOf, extractText } from '../extract';
import type { CallModelFn } from './types';

export const DRIVE_INDEX_MODEL = 'gemini-3.5-flash-lite';
export const INDEX_FILE_NAME = '_virmeet-index.md';

// A folder with more new/changed files than this in one run only gets the
// first N summarized — same "budget everything" discipline as
// maxApiCalls/maxWebSearches elsewhere in the engine. The rest keep
// whatever they had (or go unsummarized until a later run), rather than one
// large folder burning an unbounded number of calls at meeting start.
const MAX_FILES_TO_SUMMARIZE_PER_RUN = 20;

export interface PersonaKnowledgeFile {
  name: string;
  modifiedTime: string;
  summary: string;
}

export interface RefreshResult {
  files: PersonaKnowledgeFile[];
  changedCount: number;
  totalCount: number;
  truncated: boolean;
}

/** Renders the index as a simple, line-per-file Markdown list — human-readable in Drive, mechanically parseable by `parseIndexContent`. */
export function renderIndexContent(files: PersonaKnowledgeFile[]): string {
  const lines = files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `- ${f.name} | ${f.modifiedTime} | ${f.summary.replace(/\n/g, ' ').trim()}`);
  return [
    '# אינדקס ידע (Virmeet)',
    '',
    'קובץ זה נוצר ומתוחזק אוטומטית על ידי Virmeet — אין לערוך ידנית, השינויים יידרסו.',
    '',
    ...lines,
  ].join('\n');
}

const INDEX_LINE_RE = /^- (.+?) \| (.+?) \| (.*)$/;

/** Parses an index file's content back into a name -> {modifiedTime, summary} map. Malformed lines are skipped, not fatal. */
export function parseIndexContent(content: string): Map<string, { modifiedTime: string; summary: string }> {
  const map = new Map<string, { modifiedTime: string; summary: string }>();
  for (const line of content.split('\n')) {
    const match = INDEX_LINE_RE.exec(line);
    if (!match) continue;
    map.set(match[1], { modifiedTime: match[2], summary: match[3] });
  }
  return map;
}

async function summarizeFile(
  callModel: CallModelFn,
  name: string,
  text: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  const result = await callModel({
    model: DRIVE_INDEX_MODEL,
    system: [
      {
        type: 'text',
        text: 'את/ה מסכם/ת קבצי רקע בקצרה עבור מערכת סימולציית פגישות. תן משפט אחד עד שניים בעברית שמתארים את תוכן הקובץ ואת מה שחשוב לדעת ממנו — לא כותרת גנרית.',
      },
    ],
    messages: [{ role: 'user', content: `שם הקובץ: ${name}\n\nתוכן הקובץ:\n${text.slice(0, 20_000)}` }],
    maxTokens: 300,
    effort: 'low',
    apiKey,
    signal,
  });
  if (result.refused || result.truncated || !result.text.trim()) {
    return '(לא ניתן היה להפיק תקציר לקובץ זה)';
  }
  return result.text.trim();
}

/**
 * Refreshes `folderId`'s knowledge index: lists the folder, reads the
 * existing index file (if any), re-summarizes new/changed files (capped at
 * `MAX_FILES_TO_SUMMARIZE_PER_RUN`), and writes the updated index back to
 * Drive. Throws on a Drive/network failure — callers (runner.ts) decide how
 * to degrade per persona, same as any other per-persona failure.
 */
export async function refreshPersonaDriveIndex(
  token: string,
  folderId: string,
  callModel: CallModelFn,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn = fetch
): Promise<RefreshResult> {
  const [driveFiles, existingIndexId] = await Promise.all([
    listFolderFiles(token, folderId, fetchFn),
    findFile(token, INDEX_FILE_NAME, folderId, fetchFn),
  ]);
  const knowledgeFiles = driveFiles.filter((f) => f.name !== INDEX_FILE_NAME);

  const previousEntries = existingIndexId
    ? parseIndexContent(await downloadFileText(token, existingIndexId, fetchFn))
    : new Map<string, { modifiedTime: string; summary: string }>();

  let summarized = 0;
  let changedCount = 0;
  let truncated = false;
  const files: PersonaKnowledgeFile[] = [];

  for (const file of knowledgeFiles) {
    const previous = previousEntries.get(file.name);
    if (previous && previous.modifiedTime === file.modifiedTime) {
      files.push({ name: file.name, modifiedTime: file.modifiedTime, summary: previous.summary });
      continue;
    }

    if (summarized >= MAX_FILES_TO_SUMMARIZE_PER_RUN) {
      truncated = true;
      // Keep the stale summary (if any) rather than dropping the file from the index entirely.
      if (previous) files.push({ name: file.name, modifiedTime: previous.modifiedTime, summary: previous.summary });
      continue;
    }

    changedCount += 1;
    summarized += 1;
    try {
      const buffer = await downloadFileMedia(token, file.id, fetchFn);
      const extraction = await extractText(buffer, extensionOf(file.name));
      const summary = extraction.error
        ? `(לא ניתן היה לחלץ טקסט מהקובץ: ${extraction.error})`
        : await summarizeFile(callModel, file.name, extraction.text, apiKey, signal);
      files.push({ name: file.name, modifiedTime: file.modifiedTime, summary });
    } catch (err) {
      files.push({
        name: file.name,
        modifiedTime: file.modifiedTime,
        summary: `(עיבוד הקובץ נכשל: ${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  await upsertTextFile(token, INDEX_FILE_NAME, folderId, renderIndexContent(files), 'text/markdown', fetchFn);

  return { files, changedCount, totalCount: knowledgeFiles.length, truncated };
}
