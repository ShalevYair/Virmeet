// Virmeet — text extraction, browser-only (spec §5.4).
// Extraction must NEVER throw and must never crash the app: on failure we
// return extractedText: '' plus a Hebrew extractionError. Same contract as
// the old server-side version — only the input type and the libraries
// (pdf.js + mammoth's browser build) changed.

import { seedUrl } from './base-path';

const MAX_CHARS = 60_000;
const TRUNCATION_NOTE = '\n\n[הקובץ קוצץ]';

export interface ExtractionResult {
  text: string;
  error?: string;
}

/** Lowercased extension including the leading dot, e.g. "report.PDF" -> ".pdf". */
export function extensionOf(name: string): string {
  const match = name.match(/\.[^./\\]+$/);
  return match ? match[0].toLowerCase() : '';
}

/** Whatever the caller has on hand — an uploaded `File`, a fetched `Blob`, or raw bytes. */
export type ExtractableFile = File | Blob | ArrayBuffer;

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + TRUNCATION_NOTE;
}

async function toArrayBuffer(file: ExtractableFile): Promise<ArrayBuffer> {
  if (file instanceof ArrayBuffer) return file;
  return file.arrayBuffer();
}

async function extractPlainText(file: ExtractableFile): Promise<string> {
  if (file instanceof Blob) return file.text();
  return new TextDecoder('utf-8').decode(file);
}

async function extractDocx(file: ExtractableFile): Promise<string> {
  // Lazy import so this heavy dependency is never pulled into the initial
  // bundle, and so nothing here executes during the build's static prerender.
  const mammoth = await import('mammoth');
  const arrayBuffer = await toArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractPdf(file: ExtractableFile): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = seedUrl('pdf.worker.min.mjs');

  const arrayBuffer = await toArrayBuffer(file);
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    pageTexts.push(pageText);
  }
  return pageTexts.join('\n\n');
}

/**
 * Extract text from a file. `ext` is the lowercased extension (including the
 * leading dot). Never throws — on any failure, returns
 * `{ text: '', error: '<Hebrew message>' }`.
 */
export async function extractText(file: ExtractableFile, ext: string): Promise<ExtractionResult> {
  try {
    switch (ext) {
      case '.txt':
      case '.md':
      case '.csv':
      case '.json': {
        const text = await extractPlainText(file);
        return { text: truncate(text) };
      }
      case '.docx': {
        try {
          const text = await extractDocx(file);
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
          const text = await extractPdf(file);
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
    // Catch-all safety net — a read failure (e.g. corrupt upload) must never
    // propagate and crash the caller.
    return { text: '', error: `חילוץ הטקסט נכשל: ${errorMessage(err)}` };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
