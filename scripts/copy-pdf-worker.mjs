#!/usr/bin/env node
// Virmeet — copies pdf.js's worker script into public/ so the browser can
// load it as a plain static asset (via seedUrl('pdf.worker.min.mjs')).
// pdf.js requires a worker file at runtime; importing it through a bundler
// asset-URL loader is not reliable under `output: 'export'`, so we ship it
// as a static file instead (see docs/PLAN-static-github-pages.md §5.4).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
const DEST = path.join(ROOT, 'public', 'pdf.worker.min.mjs');

fs.copyFileSync(SRC, DEST);
console.log(`[copy-pdf-worker] copied ${path.relative(ROOT, SRC)} -> ${path.relative(ROOT, DEST)}`);
