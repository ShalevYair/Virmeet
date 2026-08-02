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

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the handful of XML entities that show up in OOXML text runs — no need for a full XML parser for this. */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (match, entity: string) => {
    if (entity[0] === '#') return String.fromCharCode(Number(entity.slice(1)));
    return XML_ENTITIES[entity] ?? match;
  });
}

/**
 * Parses `xl/sharedStrings.xml` into an index -> text array. XLSX stores
 * repeated cell text once here and cells reference it by index (`t="s"`) —
 * without this, string cells come out as bare numbers.
 */
function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((entry) =>
    [...entry[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((run) => decodeXmlEntities(run[1])).join('')
  );
}

/** Resolves one `<c>` cell's displayed text, given its raw attribute string and inner XML. */
function cellText(attrs: string, inner: string, sharedStrings: string[]): string {
  const type = attrs.match(/\bt="([a-zA-Z]+)"/)?.[1];
  if (type === 's') {
    const index = Number(inner.match(/<v>([^<]*)<\/v>/)?.[1]);
    return Number.isFinite(index) ? (sharedStrings[index] ?? '') : '';
  }
  if (type === 'inlineStr') {
    return [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((run) => decodeXmlEntities(run[1])).join('');
  }
  const value = inner.match(/<v>([^<]*)<\/v>/)?.[1];
  return value !== undefined ? decodeXmlEntities(value) : '';
}

/** Flattens one worksheet's XML to one line of comma-separated cell text per row. */
function parseSheetXml(xml: string, sharedStrings: string[]): string {
  // Self-closing cells (`<c r="A1"/>`, i.e. empty) carry no <v>/<is> — normalize
  // to a zero-length body so the single regex below covers both forms.
  const normalized = xml.replace(/<c\b([^>]*)\/>/g, '<c$1></c>');
  const lines: string[] = [];
  for (const row of normalized.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) =>
      cellText(cell[1], cell[2], sharedStrings)
    );
    if (values.some((v) => v !== '')) lines.push(values.join(', '));
  }
  return lines.join('\n');
}

/**
 * Flattens every sheet to one comma-separated line of cell text per row, one
 * heading per sheet. Hand-parses the OOXML directly via JSZip (xlsx is just
 * a zip of XML files) instead of pulling in the `xlsx` npm package — that
 * package's published build has unresolved high-severity advisories
 * (prototype pollution, ReDoS) with no registry fix. This only reads
 * `<v>`/`<is>` text content, so it can't render formulas, formatting, charts,
 * or merged-cell layout — good enough for a plain-text summary, not a
 * spreadsheet viewer.
 */
async function extractXlsx(file: ExtractableFile): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const arrayBuffer = await toArrayBuffer(file);
  const zip = await JSZip.loadAsync(arrayBuffer);

  const sharedStringsEntry = zip.files['xl/sharedStrings.xml'];
  const sharedStrings = sharedStringsEntry ? parseSharedStrings(await sharedStringsEntry.async('text')) : [];

  const relsEntry = zip.files['xl/_rels/workbook.xml.rels'];
  const relsXml = relsEntry ? await relsEntry.async('text') : '';
  const targetByRelId = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = rel[1].match(/\bId="([^"]*)"/)?.[1];
    const target = rel[1].match(/\bTarget="([^"]*)"/)?.[1];
    if (id && target) targetByRelId.set(id, target);
  }

  const workbookXml = await zip.files['xl/workbook.xml'].async('text');
  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)]
    .map((sheet) => {
      const name = sheet[1].match(/\bname="([^"]*)"/)?.[1] ?? 'Sheet';
      const relId = sheet[1].match(/\br:id="([^"]*)"/)?.[1];
      const target = relId ? targetByRelId.get(relId) : undefined;
      return target ? { name: decodeXmlEntities(name), path: `xl/${target.replace(/^\/+/, '')}` } : null;
    })
    .filter((s): s is { name: string; path: string } => s !== null);

  const sheetTexts: string[] = [];
  for (const sheet of sheets) {
    const entry = zip.files[sheet.path];
    if (!entry) continue;
    sheetTexts.push(`## ${sheet.name}\n${parseSheetXml(await entry.async('text'), sharedStrings)}`);
  }
  return sheetTexts.join('\n\n');
}

/** Unzips the .pptx (OOXML is just a zip) and pulls text runs (`<a:t>`) out of each slide's XML, in slide order — a plain-text flattening, not a real PPTX parser. */
async function extractPptx(file: ExtractableFile): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const arrayBuffer = await toArrayBuffer(file);
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)![1]) - Number(b.match(/slide(\d+)\.xml/)![1]));

  const slideTexts: string[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    slideTexts.push(`## שקופית ${i + 1}\n${runs.join(' ')}`);
  }
  return slideTexts.join('\n\n');
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
      case '.xlsx': {
        try {
          const text = await extractXlsx(file);
          return { text: truncate(text) };
        } catch (err) {
          return {
            text: '',
            error: `חילוץ הטקסט מקובץ ה-Excel נכשל: ${errorMessage(err)}`,
          };
        }
      }
      case '.pptx': {
        try {
          const text = await extractPptx(file);
          return { text: truncate(text) };
        } catch (err) {
          return {
            text: '',
            error: `חילוץ הטקסט מקובץ ה-PowerPoint נכשל: ${errorMessage(err)}`,
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
