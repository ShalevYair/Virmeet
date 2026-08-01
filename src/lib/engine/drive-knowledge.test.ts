import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../drive';
import { INDEX_FILE_NAME, parseIndexContent, refreshPersonaDriveIndex, renderIndexContent } from './drive-knowledge';
import type { CallModelFn } from './types';
import type { CallModelResult } from '../llm-types';

function driveJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function summaryResult(text: string): CallModelResult {
  return { text, webSearches: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, refused: false, truncated: false };
}

describe('renderIndexContent / parseIndexContent round-trip', () => {
  it('parses back exactly what was rendered', () => {
    const files = [
      { name: 'b.pdf', modifiedTime: '2026-01-02T00:00:00.000Z', summary: 'תקציר ב' },
      { name: 'a.txt', modifiedTime: '2026-01-01T00:00:00.000Z', summary: 'תקציר א, עם פסיק' },
    ];
    const content = renderIndexContent(files);
    const parsed = parseIndexContent(content);
    expect(parsed.get('a.txt')).toEqual({ modifiedTime: '2026-01-01T00:00:00.000Z', summary: 'תקציר א, עם פסיק' });
    expect(parsed.get('b.pdf')).toEqual({ modifiedTime: '2026-01-02T00:00:00.000Z', summary: 'תקציר ב' });
  });

  it('ignores unparseable lines instead of throwing', () => {
    const parsed = parseIndexContent('# heading\n\nnot a list line\n- also not enough fields');
    expect(parsed.size).toBe(0);
  });
});

describe('refreshPersonaDriveIndex', () => {
  function makeFetchFn(opts: {
    listedFiles: { id: string; name: string; modifiedTime: string }[];
    existingIndexId?: string;
    existingIndexContent?: string;
    fileContents?: Record<string, string>;
  }): { fetchFn: FetchFn; writes: { url: string; body: string }[] } {
    const writes: { url: string; body: string }[] = [];
    const fetchFn: FetchFn = vi.fn(async (url, init) => {
      const urlStr = String(url);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (urlStr.includes('/files?q=') && urlStr.includes('name%3D')) {
        // findFile — its query has a name= clause; listFolderFiles's doesn't.
        return driveJson({ files: opts.existingIndexId ? [{ id: opts.existingIndexId }] : [] });
      }
      if (urlStr.includes('/files?q=')) {
        // listFolderFiles (non-folder listing)
        return driveJson({ files: opts.listedFiles });
      }
      if (urlStr.includes('alt=media')) {
        const fileId = urlStr.split('/files/')[1].split('?')[0];
        if (fileId === opts.existingIndexId) return new Response(opts.existingIndexContent ?? '');
        return new Response(opts.fileContents?.[fileId] ?? '');
      }
      if (method === 'PATCH') {
        writes.push({ url: urlStr, body: String((init as RequestInit).body) });
        return new Response('{}');
      }
      if (method === 'POST') {
        return driveJson({ id: 'new-index-id' });
      }
      throw new Error(`unexpected request: ${method} ${urlStr}`);
    }) as unknown as FetchFn;
    return { fetchFn, writes };
  }

  it('reuses the existing summary for a file whose modifiedTime is unchanged, without calling the model', async () => {
    const { fetchFn, writes } = makeFetchFn({
      listedFiles: [{ id: 'file-1', name: 'a.txt', modifiedTime: '2026-01-01T00:00:00.000Z' }],
      existingIndexId: 'index-id',
      existingIndexContent: renderIndexContent([
        { name: 'a.txt', modifiedTime: '2026-01-01T00:00:00.000Z', summary: 'תקציר קיים' },
      ]),
    });
    const callModel: CallModelFn = vi.fn(async () => {
      throw new Error('should not be called for an unchanged file');
    });

    const result = await refreshPersonaDriveIndex('token', 'folder-id', callModel, undefined, undefined, fetchFn);

    expect(result.changedCount).toBe(0);
    expect(result.totalCount).toBe(1);
    expect(result.files).toEqual([{ name: 'a.txt', modifiedTime: '2026-01-01T00:00:00.000Z', summary: 'תקציר קיים' }]);
    expect(writes).toHaveLength(1); // still rewrites the index file once
  });

  it('re-summarizes a new file via the model and writes it into the updated index', async () => {
    const { fetchFn, writes } = makeFetchFn({
      listedFiles: [{ id: 'file-1', name: 'new.txt', modifiedTime: '2026-02-01T00:00:00.000Z' }],
      fileContents: { 'file-1': 'תוכן הקובץ החדש' },
    });
    const callModel: CallModelFn = vi.fn(async (opts) => {
      expect(opts.model).toBe('gemini-3.5-flash-lite');
      return summaryResult('תקציר חדש שנוצר');
    });

    const result = await refreshPersonaDriveIndex('token', 'folder-id', callModel, 'api-key', undefined, fetchFn);

    expect(result.changedCount).toBe(1);
    expect(result.files[0]).toEqual({
      name: 'new.txt',
      modifiedTime: '2026-02-01T00:00:00.000Z',
      summary: 'תקציר חדש שנוצר',
    });
    expect(writes[0].body).toContain('new.txt');
    expect(writes[0].body).toContain('תקציר חדש שנוצר');
  });

  it('excludes its own index file from the knowledge listing', async () => {
    const { fetchFn } = makeFetchFn({
      listedFiles: [
        { id: 'idx', name: INDEX_FILE_NAME, modifiedTime: '2026-01-01T00:00:00.000Z' },
        { id: 'file-1', name: 'a.txt', modifiedTime: '2026-01-01T00:00:00.000Z' },
      ],
      fileContents: { 'file-1': 'תוכן' },
    });
    const callModel: CallModelFn = vi.fn(async () => summaryResult('תקציר'));

    const result = await refreshPersonaDriveIndex('token', 'folder-id', callModel, undefined, undefined, fetchFn);

    expect(result.totalCount).toBe(1);
    expect(result.files.map((f) => f.name)).toEqual(['a.txt']);
  });
});
