import { describe, expect, it, vi } from 'vitest';
import {
  createFolder,
  ensureFolder,
  ensurePersonaFolder,
  ensureVirmeetRootFolder,
  escapeDriveQueryValue,
  findFolder,
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
