// Virmeet — typed fetch helpers for the browser side (spec §5).
// Every API route returns `{ error: 'הודעה בעברית' }` on failure; this module
// normalizes that into a thrown ApiError so callers can surface it inline.

import type {
  AttachedFile,
  Meeting,
  MeetingPhase,
  MeetingResult,
  MeetingType,
  OrgSettings,
  Persona,
  TranscriptEntry,
} from './types';
import { getStoredApiKey } from './api-key';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type MeetingSummary = Omit<Meeting, 'transcript' | 'result'>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('לא ניתן להתחבר לשרת. בדקו את החיבור ונסו שוב.', 0);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body (shouldn't happen per spec, but don't crash on it).
    }
  }

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as { error: unknown }).error)
        : `שגיאה לא צפויה (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return data as T;
}

function json(body: unknown): string {
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const healthApi = {
  get: () =>
    request<{ anthropicKeyConfigured: boolean; geminiKeyConfigured: boolean }>('/api/health'),
};

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export type PersonaInput = {
  name: string;
  role: string;
  organization: string;
  color: string;
  prompt: string;
  model: string;
  webAccess: boolean;
  maxApiCalls: number;
  maxWebSearches: number;
  isActive?: boolean;
};

export const personasApi = {
  list: () => request<Persona[]>('/api/personas'),
  get: (id: string) => request<Persona>(`/api/personas/${id}`),
  create: (input: PersonaInput) =>
    request<Persona>('/api/personas', { method: 'POST', body: json(input) }),
  update: (id: string, patch: Partial<PersonaInput>) =>
    request<Persona>(`/api/personas/${id}`, { method: 'PATCH', body: json(patch) }),
  remove: (id: string) => request<void>(`/api/personas/${id}`, { method: 'DELETE' }),
  uploadFile: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<AttachedFile | Persona>(`/api/personas/${id}/files`, {
      method: 'POST',
      body: form,
    });
  },
  deleteFile: (id: string, fileId: string) =>
    request<void>(`/api/personas/${id}/files/${fileId}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Meeting types
// ---------------------------------------------------------------------------

export type MeetingTypeInput = {
  title: string;
  shortDescription: string;
  prompt: string;
};

export const meetingTypesApi = {
  list: () => request<MeetingType[]>('/api/meeting-types'),
  get: (id: string) => request<MeetingType>(`/api/meeting-types/${id}`),
  create: (input: MeetingTypeInput) =>
    request<MeetingType>('/api/meeting-types', { method: 'POST', body: json(input) }),
  update: (id: string, patch: Partial<MeetingTypeInput>) =>
    request<MeetingType>(`/api/meeting-types/${id}`, { method: 'PATCH', body: json(patch) }),
  remove: (id: string) => request<void>(`/api/meeting-types/${id}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export type OrgSettingsInput = Partial<Omit<OrgSettings, 'updatedAt'>>;

export const orgApi = {
  get: () => request<OrgSettings>('/api/org'),
  update: (patch: OrgSettingsInput) =>
    request<OrgSettings>('/api/org', { method: 'PATCH', body: json(patch) }),
};

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export type MeetingCreateInput = {
  title: string;
  meetingTypeIds: string[];
  objective: string;
  participantIds: string[];
  discussionRounds?: number;
};

export const meetingsApi = {
  list: () => request<MeetingSummary[]>('/api/meetings'),
  get: (id: string) => request<Meeting>(`/api/meetings/${id}`),
  create: (input: MeetingCreateInput) =>
    request<Meeting>('/api/meetings', { method: 'POST', body: json(input) }),
  update: (id: string, patch: Partial<Meeting>) =>
    request<Meeting>(`/api/meetings/${id}`, { method: 'PATCH', body: json(patch) }),
  remove: (id: string) => request<void>(`/api/meetings/${id}`, { method: 'DELETE' }),
  uploadFile: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<AttachedFile | Meeting>(`/api/meetings/${id}/files`, {
      method: 'POST',
      body: form,
    });
  },
  deleteFile: (id: string, fileId: string) =>
    request<void>(`/api/meetings/${id}/files?fileId=${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    }),
  exportUrl: (id: string, format: 'md' | 'json') => `/api/meetings/${id}/export?format=${format}`,
};

// ---------------------------------------------------------------------------
// Meeting run — SSE over a POST fetch stream (spec §6: EventSource cannot POST).
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: 'phase'; phase: MeetingPhase }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'done'; result: MeetingResult }
  | { type: 'error'; message: string };

export interface RunMeetingHandlers {
  onPhase?: (phase: MeetingPhase) => void;
  onEntry?: (entry: TranscriptEntry) => void;
  onDone?: (result: MeetingResult) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * Consumes the SSE stream from POST /api/meetings/[id]/run using fetch + a
 * ReadableStream reader. Resolves when the stream ends (either via a `done`/
 * `error` event or the connection simply closing). Never throws on a
 * mid-stream disconnect — callers should fall back to polling GET
 * /api/meetings/[id] afterwards to reconcile final state.
 */
export async function runMeeting(id: string, handlers: RunMeetingHandlers): Promise<void> {
  let res: Response;
  try {
    // Personal keys pasted into Settings — if present — travel only in these
    // two headers, only to our own /api/meetings/[id]/run endpoint. This is
    // the single place that attaches them; nothing else in the client sends them.
    const anthropicKey = getStoredApiKey('anthropic');
    const geminiKey = getStoredApiKey('gemini');
    const headers: Record<string, string> = {};
    if (anthropicKey) headers['x-anthropic-api-key'] = anthropicKey;
    if (geminiKey) headers['x-gemini-api-key'] = geminiKey;
    res = await fetch(`/api/meetings/${id}/run`, {
      method: 'POST',
      signal: handlers.signal,
      headers: Object.keys(headers).length ? headers : undefined,
    });
  } catch {
    handlers.onError?.('לא ניתן היה להתחיל את הפגישה — בדקו את החיבור לשרת.');
    return;
  }

  if (!res.ok || !res.body) {
    let message = `שגיאה בהפעלת הפגישה (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore — keep the generic message
    }
    handlers.onError?.(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const chunk of events) {
        const line = chunk
          .split('\n')
          .find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice('data:'.length).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload) as RunEvent;
          switch (parsed.type) {
            case 'phase':
              handlers.onPhase?.(parsed.phase);
              break;
            case 'entry':
              handlers.onEntry?.(parsed.entry);
              break;
            case 'done':
              handlers.onDone?.(parsed.result);
              break;
            case 'error':
              handlers.onError?.(parsed.message);
              break;
          }
        } catch {
          // Malformed event — skip it rather than killing the whole stream.
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    // Mid-stream disconnect: swallow here, caller falls back to polling GET.
  }
}
