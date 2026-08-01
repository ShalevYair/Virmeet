import { describe, expect, it } from 'vitest';
import { buildPersonaSystemBlocks } from './prompts';
import { makeMeeting, makeOrg, makePersona } from './__tests__/helpers';
import type { AttachedFile } from '../types';
import type { PersonaKnowledgeFile } from './drive-knowledge';

const org = makeOrg();
const persona = makePersona({ files: [] });
const meeting = makeMeeting({ files: [] });

const indexFile: PersonaKnowledgeFile = { name: 'a.pdf', modifiedTime: '2026-01-01T00:00:00.000Z', summary: 'תקציר קצר' };
const deepReadFile: AttachedFile = {
  id: 'file-id',
  name: 'a.pdf',
  mimeType: 'application/octet-stream',
  sizeBytes: 10,
  storedPath: '',
  extractedText: 'התוכן המלא של הקובץ',
  addedAt: '2026-01-01T00:00:00.000Z',
};

describe('buildPersonaSystemBlocks — Drive knowledge blocks', () => {
  it('omits both Drive blocks when no Drive knowledge is passed', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting);
    expect(blocks).toHaveLength(4); // org, sharedFiles, personaPrompt, personaFiles
    expect(blocks.some((b) => b.text.includes('קבצי ידע זמינים ב-Drive'))).toBe(false);
    expect(blocks.some((b) => b.text.includes('קבצים מ-Drive שביקשת לקרוא לעומק'))).toBe(false);
  });

  it('adds the index-summary block (but not the deep-read block) when only an index is available — the prep-call shape', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting, { indexSummary: [indexFile] });
    expect(blocks).toHaveLength(5);
    expect(blocks[4].text).toContain('קבצי ידע זמינים ב-Drive');
    expect(blocks[4].text).toContain('a.pdf: תקציר קצר');
    expect(blocks.some((b) => b.text.includes('קבצים מ-Drive שביקשת לקרוא לעומק'))).toBe(false);
  });

  it('adds both blocks, index summary before deep-read, once deep-read files exist — the post-prep shape', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting, {
      indexSummary: [indexFile],
      deepReadFiles: [deepReadFile],
    });
    expect(blocks).toHaveLength(6);
    expect(blocks[4].text).toContain('קבצי ידע זמינים ב-Drive');
    expect(blocks[5].text).toContain('קבצים מ-Drive שביקשת לקרוא לעומק');
    expect(blocks[5].text).toContain('התוכן המלא של הקובץ');
  });

  it('omits an empty indexSummary array the same as if it were never passed', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting, { indexSummary: [] });
    expect(blocks).toHaveLength(4);
  });

  it('keeps the first four (stable-prefix) blocks byte-identical regardless of Drive knowledge, for cache-hit stability', () => {
    const withoutDrive = buildPersonaSystemBlocks(org, persona, meeting);
    const withDrive = buildPersonaSystemBlocks(org, persona, meeting, {
      indexSummary: [indexFile],
      deepReadFiles: [deepReadFile],
    });
    expect(withDrive.slice(0, 4)).toEqual(withoutDrive);
  });
});
