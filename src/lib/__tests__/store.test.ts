import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// store.ts resolves DATA_DIR from process.cwd() at import time, so we must
// chdir into an isolated temp directory *before* importing it — otherwise
// these tests would read/write the real repo's data/ directory.
describe('store', () => {
  let store: typeof import('../store');
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virmeet-store-test-'));
    process.chdir(tmpDir);
    store = await import('../store');
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('sanitizeFilename', () => {
    it('strips path traversal and separators', () => {
      expect(store.sanitizeFilename('../../etc/passwd')).not.toContain('..');
      expect(store.sanitizeFilename('../../etc/passwd')).not.toContain('/');
      expect(store.sanitizeFilename('a/b\\c')).not.toMatch(/[/\\]/);
    });

    it('strips control characters', () => {
      const sanitized = store.sanitizeFilename('a\x00\x1fb.txt');
      expect(sanitized).toBe('ab.txt');
    });

    it('falls back to a safe default for empty or dot-only names', () => {
      expect(store.sanitizeFilename('')).toBe('file');
      expect(store.sanitizeFilename('.')).toBe('file');
      expect(store.sanitizeFilename('..')).toBe('file');
    });
  });

  describe('saveUpload', () => {
    function fakeFile(name: string, size: number): { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } {
      return {
        name,
        type: 'text/plain',
        size,
        arrayBuffer: async () => {
          throw new Error('arrayBuffer() must not be read once size/extension validation has already failed');
        },
      };
    }

    it('rejects a disallowed file extension before reading its contents', async () => {
      await expect(store.saveUpload('owner1', fakeFile('malware.exe', 100))).rejects.toThrow('סוג קובץ לא נתמך');
    });

    it('rejects a file over 10MB before reading its contents', async () => {
      await expect(store.saveUpload('owner1', fakeFile('big.txt', 11 * 1024 * 1024))).rejects.toThrow('גדול מדי');
    });

    it('accepts an allowed extension under the size limit', async () => {
      const file = {
        name: 'notes.txt',
        type: 'text/plain',
        size: 12,
        arrayBuffer: async () => new TextEncoder().encode('hello world!').buffer,
      };
      const saved = await store.saveUpload('owner1', file);
      expect(saved.name).toBe('notes.txt');
      expect(saved.extractedText).toBe('hello world!');
    });
  });

  describe('transact — concurrent writes', () => {
    it('does not lose an update when two createPersona calls race', async () => {
      const before = await store.listPersonas();

      const input = {
        name: 'x',
        role: 'x',
        organization: 'x',
        color: '#000',
        prompt: 'x',
        model: 'claude-sonnet-5',
        webAccess: false,
        maxApiCalls: 5,
        maxWebSearches: 0,
      };

      const [a, b] = await Promise.all([
        store.createPersona({ ...input, name: 'racer-a' }),
        store.createPersona({ ...input, name: 'racer-b' }),
      ]);

      const after = await store.listPersonas();
      expect(after.length).toBe(before.length + 2);
      expect(after.some((p) => p.id === a.id)).toBe(true);
      expect(after.some((p) => p.id === b.id)).toBe(true);
    });
  });

  describe('corrupt JSON -> reseed', () => {
    it('recovers from a corrupted org.json by reseeding it', async () => {
      const dataDir = store._internal.DATA_DIR;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'org.json'), '{this is not valid json', 'utf-8');

      const settings = await store.getOrgSettings();
      expect(settings.organizationName).toBeTruthy();
      expect(settings.maxMeetingApiCalls).toBeGreaterThan(0);

      // The file on disk should now be valid JSON, not the corrupted contents.
      const raw = await fs.readFile(path.join(dataDir, 'org.json'), 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  describe('meetings summary index (P4.4)', () => {
    const indexPath = () => path.join(store._internal.MEETINGS_DIR, '_index.json');

    it('is created and kept in sync by createMeeting/updateMeeting/deleteMeeting', async () => {
      const meeting = await store.createMeeting({
        title: 'פגישת אינדקס',
        meetingTypeIds: ['t1'],
        objective: 'מטרה',
        participantIds: ['p1', 'p2'],
      });

      const indexRaw = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as { id: string; title: string }[];
      expect(indexRaw.some((m) => m.id === meeting.id && m.title === 'פגישת אינדקס')).toBe(true);

      // listMeetings(true) must never include transcript/result, whether it
      // came from the index or a full-scan fallback.
      const summaries = await store.listMeetings(true);
      const found = summaries.find((m) => m.id === meeting.id);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty('transcript');
      expect(found).not.toHaveProperty('result');

      await store.updateMeeting(meeting.id, { status: 'cancelled' });
      const afterUpdate = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as { id: string; status: string }[];
      expect(afterUpdate.find((m) => m.id === meeting.id)?.status).toBe('cancelled');

      await store.deleteMeeting(meeting.id);
      const afterDelete = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as { id: string }[];
      expect(afterDelete.some((m) => m.id === meeting.id)).toBe(false);
    });

    it('falls back to a full scan and self-heals when the index is missing or corrupt', async () => {
      const meeting = await store.createMeeting({
        title: 'פגישה לפני קריסת האינדקס',
        meetingTypeIds: ['t1'],
        objective: 'מטרה',
        participantIds: ['p1', 'p2'],
      });

      await fs.writeFile(indexPath(), '{not valid json at all', 'utf-8');

      const summaries = await store.listMeetings(true);
      expect(summaries.some((m) => m.id === meeting.id)).toBe(true);

      // The corrupt index should have been repaired by the fallback scan.
      const repaired = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as { id: string }[];
      expect(repaired.some((m) => m.id === meeting.id)).toBe(true);
    });

    it('never lets "_index.json" itself be mistaken for a meeting id', async () => {
      await store.createMeeting({
        title: 'עוד פגישה',
        meetingTypeIds: ['t1'],
        objective: 'מטרה',
        participantIds: ['p1', 'p2'],
      });
      const all = await store.listMeetings(false);
      expect(all.every((m) => m.id !== '_index')).toBe(true);
    });
  });
});
