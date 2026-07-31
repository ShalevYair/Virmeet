// Virmeet — facade over store.ts (spec §5, §5.1 of docs/PLAN-static-github-pages.md).
// There is no server anymore: every "API" call here talks straight to
// IndexedDB via store.ts. This module exists so the page components barely
// changed — they still call e.g. `personasApi.get(id)` and catch `ApiError`
// exactly like they did against the old fetch()-based client.

import type { AttachedFile, MeetingPhase, MeetingResult, OrgSettings, TranscriptEntry } from './types';
import { getModelProvider, isKnownModel } from './types';
import * as store from './store';
import type { MeetingSummary } from './store';
import { runMeeting as engineRunMeeting } from './engine/runner';
import { getStoredApiKey } from './api-key';
import { ensureSeedLoaded } from './seed-loader';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type { MeetingSummary };

function notFound(message: string): never {
  throw new ApiError(message, 404);
}

function badRequest(message: string): never {
  throw new ApiError(message, 400);
}

/**
 * Runs `fn` against the store, first waiting for the seed-loader's one-time
 * IndexedDB population to finish (see seed-loader.ts) so a page's very first
 * read can never race ahead of seeding and render an empty list that never
 * refreshes. Converts any thrown Error into an ApiError so existing
 * `err instanceof ApiError` UI code keeps working.
 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await ensureSeedLoaded();
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err instanceof Error ? err.message : 'שגיאה לא צפויה.', 400);
  }
}

function requireNonEmpty(value: string, fieldHebrew: string): void {
  if (!value || value.trim().length === 0) {
    badRequest(`השדה "${fieldHebrew}" הוא שדה חובה.`);
  }
}

function requireIntInRange(value: number, min: number, max: number, fieldHebrew: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    badRequest(`השדה "${fieldHebrew}" חייב להיות מספר שלם בין ${min} ל-${max}.`);
  }
}

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

/** Range/type checks that must hold no matter what — safe to apply on creation, when text fields are still blank scaffolding. */
function validatePersonaRanges(input: Partial<PersonaInput>): void {
  if (input.maxApiCalls !== undefined) requireIntInRange(input.maxApiCalls, 1, 20, 'מקסימום קריאות API');
  if (input.maxWebSearches !== undefined) requireIntInRange(input.maxWebSearches, 0, 10, 'מקסימום חיפושי רשת');
}

/** Full validation, including non-empty text fields — for saving an actually-filled-in persona. */
function validatePersonaInput(input: Partial<PersonaInput>): void {
  if (input.name !== undefined) requireNonEmpty(input.name, 'שם');
  if (input.role !== undefined) requireNonEmpty(input.role, 'תפקיד');
  if (input.organization !== undefined) requireNonEmpty(input.organization, 'ארגון');
  if (input.color !== undefined) requireNonEmpty(input.color, 'צבע');
  if (input.prompt !== undefined) requireNonEmpty(input.prompt, 'פרומפט');
  if (input.model !== undefined) requireNonEmpty(input.model, 'מודל');
  validatePersonaRanges(input);
}

export const personasApi = {
  list: () => run(() => store.listPersonas()),
  get: (id: string) =>
    run(async () => (await store.getPersona(id)) ?? notFound('המשתתף לא נמצא.')),
  // Intentionally lighter validation than update(): "+ הוסף משתתף" creates a
  // blank scaffold (empty role/organization/prompt) and immediately navigates
  // to the edit page for the user to fill in — only the numeric fields (which
  // always have real default values) need checking here.
  create: (input: PersonaInput) =>
    run(async () => {
      validatePersonaRanges(input);
      return store.createPersona(input);
    }),
  update: (id: string, patch: Partial<PersonaInput>) =>
    run(async () => {
      validatePersonaInput(patch);
      return (await store.updatePersona(id, patch)) ?? notFound('המשתתף לא נמצא.');
    }),
  remove: (id: string) =>
    run(async () => {
      if (!(await store.deletePersona(id))) notFound('המשתתף לא נמצא.');
    }),
  uploadFile: (id: string, file: File) =>
    run(async () => {
      const persona = await store.getPersona(id);
      if (!persona) notFound('המשתתף לא נמצא.');
      const attached = await store.saveUpload(file);
      const updated = await store.setPersonaFiles(id, [...persona.files, attached]);
      return updated ?? notFound('המשתתף לא נמצא.');
    }),
  deleteFile: (id: string, fileId: string) =>
    run(async () => {
      const persona = await store.getPersona(id);
      if (!persona) notFound('המשתתף לא נמצא.');
      const nextFiles = persona.files.filter((f) => f.id !== fileId);
      await store.setPersonaFiles(id, nextFiles);
    }),
};

// ---------------------------------------------------------------------------
// Meeting types
// ---------------------------------------------------------------------------

export type MeetingTypeInput = {
  title: string;
  shortDescription: string;
  prompt: string;
};

function validateMeetingTypeInput(input: Partial<MeetingTypeInput>): void {
  if (input.title !== undefined) requireNonEmpty(input.title, 'כותרת');
  if (input.shortDescription !== undefined) requireNonEmpty(input.shortDescription, 'הסבר קצר');
  if (input.prompt !== undefined) requireNonEmpty(input.prompt, 'פרומפט');
}

export const meetingTypesApi = {
  list: () => run(() => store.listMeetingTypes()),
  get: (id: string) =>
    run(async () => (await store.getMeetingType(id)) ?? notFound('סוג הפגישה לא נמצא.')),
  create: (input: MeetingTypeInput) =>
    run(async () => {
      validateMeetingTypeInput(input);
      return store.createMeetingType(input);
    }),
  update: (id: string, patch: Partial<MeetingTypeInput>) =>
    run(async () => {
      validateMeetingTypeInput(patch);
      return (await store.updateMeetingType(id, patch)) ?? notFound('סוג הפגישה לא נמצא.');
    }),
  remove: (id: string) =>
    run(async () => {
      if (!(await store.deleteMeetingType(id))) notFound('סוג הפגישה לא נמצא.');
    }),
};

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export type OrgSettingsInput = Partial<Omit<OrgSettings, 'updatedAt'>>;

export const orgApi = {
  get: () => run(() => store.getOrgSettings()),
  update: (patch: OrgSettingsInput) =>
    run(async () => {
      if (patch.organizationName !== undefined) requireNonEmpty(patch.organizationName, 'שם הארגון');
      if (patch.description !== undefined) requireNonEmpty(patch.description, 'תיאור ארגוני');
      if (patch.constraints !== undefined) requireNonEmpty(patch.constraints, 'אילוצים');
      return store.updateOrgSettings(patch);
    }),
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

export type MeetingUpdateInput = Partial<{
  title: string;
  objective: string;
  meetingTypeIds: string[];
  participantIds: string[];
  discussionRounds: number;
  status: 'draft' | 'cancelled';
}>;

async function assertParticipantsAndTypesExist(participantIds: string[], meetingTypeIds: string[]): Promise<void> {
  const [personas, meetingTypes] = await Promise.all([store.listPersonas(), store.listMeetingTypes()]);
  const personaIds = new Set(personas.map((p) => p.id));
  const meetingTypeIdSet = new Set(meetingTypes.map((t) => t.id));

  const unknownParticipant = participantIds.find((id) => !personaIds.has(id));
  if (unknownParticipant) badRequest(`המשתתף שנבחר (${unknownParticipant}) אינו קיים.`);
  const unknownType = meetingTypeIds.find((id) => !meetingTypeIdSet.has(id));
  if (unknownType) badRequest(`סוג הפגישה שנבחר (${unknownType}) אינו קיים.`);
}

export const meetingsApi = {
  list: () => run(() => store.listMeetings(true)),
  get: (id: string) => run(async () => (await store.getMeeting(id)) ?? notFound('הפגישה לא נמצאה.')),
  create: (input: MeetingCreateInput) =>
    run(async () => {
      requireNonEmpty(input.title, 'כותרת');
      requireNonEmpty(input.objective, 'מטרה');
      if (input.meetingTypeIds.length < 1) badRequest('יש לבחור לפחות סוג פגישה אחד.');
      if (input.participantIds.length < 2) badRequest('יש לבחור לפחות שני משתתפים.');
      if (input.discussionRounds !== undefined) requireIntInRange(input.discussionRounds, 1, 4, 'מספר סבבי דיון');
      await assertParticipantsAndTypesExist(input.participantIds, input.meetingTypeIds);
      return store.createMeeting(input);
    }),
  update: (id: string, patch: MeetingUpdateInput) =>
    run(async () => {
      const meeting = await store.getMeeting(id);
      if (!meeting) notFound('הפגישה לא נמצאה.');

      const editingContentFields = Object.keys(patch).some((k) => k !== 'status');
      if (editingContentFields && meeting.status !== 'draft') {
        badRequest('לא ניתן לערוך פגישה שכבר החלה לרוץ או הסתיימה.');
      }
      if (patch.status === 'cancelled' && meeting.status === 'completed') {
        badRequest('לא ניתן לבטל פגישה שכבר הושלמה.');
      }
      if (patch.status === 'draft' && meeting.status === 'completed') {
        badRequest('לא ניתן להריץ מחדש פגישה שכבר הושלמה. שכפל אותה במקום.');
      }
      if (patch.discussionRounds !== undefined) requireIntInRange(patch.discussionRounds, 1, 4, 'מספר סבבי דיון');
      if (patch.title !== undefined) requireNonEmpty(patch.title, 'כותרת');
      if (patch.objective !== undefined) requireNonEmpty(patch.objective, 'מטרה');
      if (patch.meetingTypeIds !== undefined && patch.meetingTypeIds.length < 1) {
        badRequest('יש לבחור לפחות סוג פגישה אחד.');
      }
      if (patch.participantIds !== undefined && patch.participantIds.length < 2) {
        badRequest('יש לבחור לפחות שני משתתפים.');
      }
      if (patch.participantIds || patch.meetingTypeIds) {
        await assertParticipantsAndTypesExist(patch.participantIds ?? meeting.participantIds, patch.meetingTypeIds ?? meeting.meetingTypeIds);
      }

      return (await store.updateMeeting(id, patch)) ?? notFound('הפגישה לא נמצאה.');
    }),
  remove: (id: string) =>
    run(async () => {
      if (!(await store.deleteMeeting(id))) notFound('הפגישה לא נמצאה.');
    }),
  uploadFile: (id: string, file: File) =>
    run(async () => {
      const meeting = await store.getMeeting(id);
      if (!meeting) notFound('הפגישה לא נמצאה.');
      if (meeting.status !== 'draft') {
        badRequest('לא ניתן להוסיף קבצי רקע לפגישה שכבר החלה לרוץ או הסתיימה.');
      }
      const attached = await store.saveUpload(file);
      const updated = await store.setMeetingFiles(id, [...meeting.files, attached]);
      return updated ?? notFound('הפגישה לא נמצאה.');
    }),
  deleteFile: (id: string, fileId: string) =>
    run(async () => {
      const meeting = await store.getMeeting(id);
      if (!meeting) notFound('הפגישה לא נמצאה.');
      const nextFiles = meeting.files.filter((f: AttachedFile) => f.id !== fileId);
      await store.setMeetingFiles(id, nextFiles);
    }),
};

// ---------------------------------------------------------------------------
// Meeting run — the engine runs in-process now; no SSE, no network hop.
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: 'phase'; phase: MeetingPhase }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'done'; result: MeetingResult }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface RunMeetingHandlers {
  onPhase?: (phase: MeetingPhase) => void;
  onEntry?: (entry: TranscriptEntry) => void;
  onDone?: (result: MeetingResult) => void;
  onError?: (message: string) => void;
  onCancelled?: () => void;
  signal?: AbortSignal;
}

/**
 * Runs the meeting engine directly in the browser and streams events to
 * `handlers`. `signal` is forwarded straight to the engine (see
 * `engine/runner.ts#abortIfCancelled`): aborting it stops the run itself at
 * the next checkpoint, not just event delivery to the UI. `aborted` below
 * still guards against events that were already in flight when the signal
 * fired. Never throws — engine failures surface through `handlers.onError`.
 */
export async function runMeeting(id: string, handlers: RunMeetingHandlers): Promise<void> {
  await ensureSeedLoaded();

  const anthropicKey = getStoredApiKey('anthropic') ?? undefined;
  const geminiKey = getStoredApiKey('gemini') ?? undefined;

  if (!anthropicKey && !geminiKey) {
    handlers.onError?.(
      'לא הוגדר אף מפתח API — לא Anthropic ולא Gemini. יש להזין מפתח אישי במסך ההגדרות (Settings) לפני התחלת הפגישה.'
    );
    return;
  }

  const meeting = await store.getMeeting(id);
  if (!meeting) {
    handlers.onError?.('הפגישה לא נמצאה.');
    return;
  }
  if (meeting.status === 'running') {
    handlers.onError?.('הפגישה כבר רצה כעת.');
    return;
  }
  if (meeting.status === 'completed') {
    handlers.onError?.('הפגישה כבר הושלמה — אי אפשר להריץ אותה שוב.');
    return;
  }
  if (meeting.participantIds.length < 2) {
    handlers.onError?.('נדרשים לפחות שני משתתפים כדי להריץ את הפגישה.');
    return;
  }

  // The facilitator always has a usable model (pickFacilitatorModel falls
  // back to whichever key exists), but a persona's model is whatever was
  // configured for it — a user who only entered a Gemini key and never
  // touched personas defaulting to Claude would otherwise only find out
  // when every one of that persona's calls fails mid-run. Check before
  // burning a single call.
  const allPersonas = await store.listPersonas();
  const personaById = new Map(allPersonas.map((p) => [p.id, p]));
  const participants = meeting.participantIds
    .map((pid) => personaById.get(pid))
    .filter((p): p is (typeof allPersonas)[number] => p != null);

  // Checked separately from (and before) the key check below: an unknown
  // model id routes silently to Anthropic (getModelProvider's fallback), so
  // folding this into blockedParticipants would surface the wrong message
  // ("דרוש מפתח API שלא הוגדר") for a persona whose real problem is a model
  // id this app doesn't know how to route at all — most likely a seed or
  // JSON-imported persona (personas/edit's own <select> can't produce one).
  const unknownModelParticipants = participants.filter((p) => !isKnownModel(p.model));
  if (unknownModelParticipants.length > 0) {
    const names = unknownModelParticipants.map((p) => `${p.name} (${p.model})`).join(', ');
    handlers.onError?.(
      `לא ניתן להתחיל את הפגישה: למשתתפים הבאים מוגדר מזהה מודל לא מוכר — ${names}. יש לבחור מודל תקין במסך עריכת המשתתף.`
    );
    return;
  }

  const hasKeyFor = (model: string): boolean =>
    getModelProvider(model) === 'gemini' ? !!geminiKey : !!anthropicKey;

  const blockedParticipants = participants.filter((p) => !hasKeyFor(p.model)).map((p) => p.name);

  if (blockedParticipants.length > 0) {
    handlers.onError?.(
      `לא ניתן להתחיל את הפגישה: למשתתפים הבאים דרוש מפתח API שלא הוגדר — ${blockedParticipants.join(
        ', '
      )}. יש להזין את המפתח החסר במסך ההגדרות (Settings), או להחליף את המודל של המשתתפים האלו למודל שתואם למפתח הקיים.`
    );
    return;
  }

  // Only 'running' and 'completed' meetings are blocked above — a meeting
  // left 'cancelled' (or 'failed') is still a 'draft' status away from being
  // run again, and the engine seeds its transcript/usage from whatever is
  // already stored (runner.ts). Reset both before starting so a re-run never
  // accumulates onto a stale run's transcript or double-counts its usage.
  // A meeting that's never been run has both already blank, so this is a
  // no-op on a genuine first run.
  await store.updateMeeting(id, {
    transcript: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
  });

  let aborted = false;
  handlers.signal?.addEventListener('abort', () => {
    aborted = true;
  });

  await engineRunMeeting(
    id,
    (event) => {
      if (aborted) return;
      switch (event.type) {
        case 'phase':
          handlers.onPhase?.(event.phase);
          break;
        case 'entry':
          handlers.onEntry?.(event.entry);
          break;
        case 'done':
          handlers.onDone?.(event.result);
          break;
        case 'error':
          handlers.onError?.(event.message);
          break;
        case 'cancelled':
          handlers.onCancelled?.();
          break;
      }
    },
    {},
    { anthropic: anthropicKey, gemini: geminiKey },
    handlers.signal
  );
}
