// Virmeet — text extraction (spec §2).
// Extraction must NEVER throw and must never crash the server: on failure we
// return extractedText: '' plus a Hebrew extractionError.

import fs from 'fs/promises';

const MAX_CHARS = 60_000;
const TRUNCATION_NOTE = '\n\n[הקובץ קוצץ]';

export interface ExtractionResult {
  text: string;
  error?: string;
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + TRUNCATION_NOTE;
}

async function extractPlainText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

async function extractDocx(filePath: string): Promise<string> {
  // Lazy import so a missing/broken native dep can't break the whole route module.
  const mammoth = await import('mammoth');
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractPdf(filePath: string): Promise<string> {
  // pdf-parse's package entry executes a debug code path on import when run
  // without guarding against its own test harness in some versions — import
  // lazily and only the function we need.
  const pdfParseModule = await import('pdf-parse');
  const pdfParse = pdfParseModule.default ?? pdfParseModule;
  const buffer = await fs.readFile(filePath);
  const result = await (pdfParse as (data: Buffer) => Promise<{ text: string }>)(buffer);
  return result.text;
}

/**
 * Extract text from a stored file. `ext` is the lowercased extension
 * (including the leading dot), as produced by `path.extname(...).toLowerCase()`.
 * Never throws — on any failure, returns `{ text: '', error: '<Hebrew message>' }`.
 */
export async function extractText(filePath: string, ext: string): Promise<ExtractionResult> {
  try {
    switch (ext) {
      case '.txt':
      case '.md':
      case '.csv':
      case '.json': {
        const text = await extractPlainText(filePath);
        return { text: truncate(text) };
      }
      case '.docx': {
        try {
          const text = await extractDocx(filePath);
          return { text: truncate(text) };
        } catch (err) {
          return {
            text: '',
            error: `חילוץ הטקסט מקובץ ה-Word נכשל: ${errorMessage(err)}`,
          };
        }
      }
      case '.pdf': {
        try {
          const text = await extractPdf(filePath);
          return { text: truncate(text) };
        } catch (err) {
          return {
            text: '',
            error: `חילוץ הטקסט מקובץ ה-PDF נכשל: ${errorMessage(err)}`,
          };
        }
      }
      default:
        return { text: '', error: `סוג קובץ לא נתמך לחילוץ טקסט: ${ext}` };
    }
  } catch (err) {
    // Catch-all safety net — a file-read failure (e.g. corrupt upload) must
    // never propagate and crash the upload request.
    return { text: '', error: `חילוץ הטקסט נכשל: ${errorMessage(err)}` };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
