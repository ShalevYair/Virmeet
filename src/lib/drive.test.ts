import { describe, expect, it, vi } from 'vitest';
import {
  createFileMetadata,
  createFolder,
  downloadFileMedia,
  downloadFileText,
  ensureFolder,
  ensurePersonaFolder,
  ensureVirmeetRootFolder,
  escapeDriveQueryValue,
  findFile,
  findFolder,
  listFolderFiles,
  updateFileContent,
  upsertTextFile,
} from './drive';
import type { FetchFn } from './drive';

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, statusText: init.statusText });
}

describe('escapeDriveQueryValue', () => {
  it('escapes single quotes and backslashes for safe use in a Drive q filter', () => {
    expect(escapeDriveQueryValue("O'Brien")).toBe("O\\'Brien");
    expect(escapeDriveQueryValue('a\\b')).toBe('a\\\\b');
  });
});

describe('findFolder', () => {
  it('returns the id of the first matching folder', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ files: [{ id: 'folder-1', name: 'CIO' }] }));
    const id = await findFolder('token', 'CIO', 'root-id', fetchFn);
    expect(id).toBe('folder-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(decodeURIComponent(String(url))).toContain("name='CIO'");
    expect(decodeURIComponent(String(url))).toContain("'root-id' in parents");
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('returns null when nothing matches', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ files: [] }));
    const id = await findFolder('token', 'CIO', 'root-id', fetchFn);
    expect(id).toBeNull();
  });

  it('throws a Hebrew error with the API message on a non-OK response', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({ error: { message: 'Invalid Credentials' } }, { status: 401, statusText: 'Unauthorized' })
    );
    await expect(findFolder('token', 'CIO', 'root-id', fetchFn)).rejects.toThrow(/Invalid Credentials/);
  });
});

describe('createFolder', () => {
  it('POSTs the folder mimeType and parent, and returns the new id', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ id: 'new-folder-id' }));
    const id = await createFolder('token', 'CIO', 'root-id', fetchFn);
    expect(id).toBe('new-folder-id');
    const [, opts] = fetchFn.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({ name: 'CIO', mimeType: 'application/vnd.google-apps.folder', parents: ['root-id'] });
  });
});

describe('ensureFolder', () => {
  it('reuses an existing folder without creating a new one', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ files: [{ id: 'existing-id' }] }));
    const result = await ensureFolder('token', 'CIO', 'root-id', fetchFn);
    expect(result).toEqual({ id: 'existing-id', created: false });
    expect(fetchFn).toHaveBeenCalledTimes(1); // search only — no POST
  });

  it('creates a folder when none was found', async () => {
    let call = 0;
    const fetchFn = vi.fn<FetchFn>(async () => {
      call += 1;
      return call === 1 ? jsonResponse({ files: [] }) : jsonResponse({ id: 'created-id' });
    });
    const result = await ensureFolder('token', 'CIO', 'root-id', fetchFn);
    expect(result).toEqual({ id: 'created-id', created: true });
    expect(fetchFn).toHaveBeenCalledTimes(2); // search, then create
  });
});

describe('ensureVirmeetRootFolder / ensurePersonaFolder', () => {
  it('ensureVirmeetRootFolder looks for "VIRMEET" directly under root', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ files: [{ id: 'root-folder-id' }] }));
    const result = await ensureVirmeetRootFolder('token', fetchFn);
    expect(result).toEqual({ id: 'root-folder-id', created: false });
    const [url] = fetchFn.mock.calls[0];
    expect(decodeURIComponent(String(url))).toContain("name='VIRMEET'");
    expect(decodeURIComponent(String(url))).toContain("'root' in parents");
  });

  it('ensurePersonaFolder looks for the persona name under the given root folder, creating it if missing', async () => {
    let call = 0;
    let searchUrl = '';
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      call += 1;
      if (call === 1) {
        searchUrl = String(url);
        return jsonResponse({ files: [] });
      }
      return jsonResponse({ id: 'persona-folder-id' });
    });
    const result = await ensurePersonaFolder('token', 'root-folder-id', 'ארכיטקט תוכנה', fetchFn);
    expect(result).toEqual({ id: 'persona-folder-id', created: true });
    expect(decodeURIComponent(searchUrl)).toContain("'root-folder-id' in parents");
  });
});

describe('listFolderFiles', () => {
  it('excludes folders from the query and returns id/name/modifiedTime', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({ files: [{ id: 'f1', name: 'a.pdf', modifiedTime: '2026-01-01T00:00:00.000Z' }] })
    );
    const files = await listFolderFiles('token', 'folder-id', fetchFn);
    expect(files).toEqual([{ id: 'f1', name: 'a.pdf', modifiedTime: '2026-01-01T00:00:00.000Z' }]);
    const [url] = fetchFn.mock.calls[0];
    expect(decodeURIComponent(String(url))).toContain("mimeType!='application/vnd.google-apps.folder'");
  });
});

describe('findFile', () => {
  it('returns the id of the first matching non-folder file', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ files: [{ id: 'idx-1' }] }));
    const id = await findFile('token', '_virmeet-index.md', 'folder-id', fetchFn);
    expect(id).toBe('idx-1');
  });

  it('returns null when nothing matches', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ files: [] }));
    expect(await findFile('token', '_virmeet-index.md', 'folder-id', fetchFn)).toBeNull();
  });
});

describe('downloadFileMedia / downloadFileText', () => {
  it('fetches ?alt=media and decodes text', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => new Response('שלום עולם'));
    const text = await downloadFileText('token', 'file-id', fetchFn);
    expect(text).toBe('שלום עולם');
    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('alt=media');
  });

  it('throws a Hebrew error on a non-OK download', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(downloadFileMedia('token', 'file-id', fetchFn)).rejects.toThrow(/404/);
  });
});

describe('createFileMetadata / updateFileContent / upsertTextFile', () => {
  it('createFileMetadata POSTs name/parents/mimeType and returns the new id', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse({ id: 'new-file-id' }));
    const id = await createFileMetadata('token', '_virmeet-index.md', 'folder-id', 'text/markdown', fetchFn);
    expect(id).toBe('new-file-id');
    const [, opts] = fetchFn.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({ name: '_virmeet-index.md', mimeType: 'text/markdown', parents: ['folder-id'] });
  });

  it('updateFileContent PATCHes the upload endpoint with the raw content', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => new Response('{}'));
    await updateFileContent('token', 'file-id', '# hello', 'text/markdown', fetchFn);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/upload/drive/v3/files/file-id');
    expect((opts as RequestInit).method).toBe('PATCH');
    expect((opts as RequestInit).body).toBe('# hello');
  });

  it('upsertTextFile updates an existing file in place instead of creating a duplicate', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn<FetchFn>(async (url, opts) => {
      calls.push(`${(opts as RequestInit | undefined)?.method ?? 'GET'} ${String(url).split('?')[0]}`);
      if (String(url).includes('/files?')) return jsonResponse({ files: [{ id: 'existing-id' }] });
      return new Response('{}');
    });
    const id = await upsertTextFile('token', '_virmeet-index.md', 'folder-id', '# content', 'text/markdown', fetchFn);
    expect(id).toBe('existing-id');
    expect(calls.some((c) => c.includes('upload/drive/v3/files/existing-id'))).toBe(true);
    expect(calls.every((c) => !c.startsWith('POST https://www.googleapis.com/drive/v3/files'))).toBe(true);
  });

  it('upsertTextFile creates the file first when it does not exist yet', async () => {
    const fetchFn = vi.fn<FetchFn>(async (url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? 'GET';
      if (String(url).includes('/files?')) return jsonResponse({ files: [] });
      if (method === 'POST') return jsonResponse({ id: 'brand-new-id' });
      return new Response('{}');
    });
    const id = await upsertTextFile('token', '_virmeet-index.md', 'folder-id', '# content', 'text/markdown', fetchFn);
    expect(id).toBe('brand-new-id');
  });
});
