// Virmeet — shared test doubles for the meeting engine (used by *.test.ts
// files under src/lib/engine/). Not a test file itself — vitest's `include`
// only picks up src/**/*.test.ts, so this module is safe to import without
// vitest trying to run it as a suite.

import { DEFAULT_MODEL } from '@/lib/types';
import type { Meeting, MeetingType, OrgSettings, Persona } from '@/lib/types';
import type { CallModelFn, RunMeetingDeps } from '@/lib/engine/types';
import type { CallModelResult } from '@/lib/llm-types';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makePersona(overrides: Partial<Persona> = {}): Persona {
  const now = new Date().toISOString();
  return {
    id: nextId('persona'),
    name: 'פרסונה לדוגמה',
    role: 'תפקיד',
    organization: 'ארגון',
    color: '#334155',
    prompt: 'פרומפט פרסונה',
    webAccess: false,
    maxApiCalls: 10,
    maxWebSearches: 0,
    files: [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeMeetingType(overrides: Partial<MeetingType> = {}): MeetingType {
  const now = new Date().toISOString();
  return {
    id: nextId('meeting-type'),
    title: 'שיחת התנעה',
    shortDescription: 'תיאור קצר',
    prompt: 'פרומפט סוג פגישה',
    isBuiltIn: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeOrg(overrides: Partial<OrgSettings> = {}): OrgSettings {
  return {
    organizationName: 'ארגון לדוגמה',
    description: 'תיאור ארגוני',
    constraints: 'אילוצים',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  const now = new Date().toISOString();
  return {
    id: nextId('meeting'),
    title: 'פגישה לדוגמה',
    meetingTypeIds: [],
    objective: 'מטרת הפגישה',
    participantIds: [],
    creatorParticipates: false,
    model: DEFAULT_MODEL,
    files: [],
    discussionRounds: 2,
    status: 'draft',
    transcript: [],
    result: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

export interface TestDeps extends RunMeetingDeps {
  /** Every patch passed to updateMeeting, in call order — asserts on the write sequence, not just the final state. */
  patches: Partial<Meeting>[];
}

/**
 * A store double whose `updateMeeting` shallow-merges each patch onto the
 * current meeting exactly like store.ts#updateMeeting does, and returns the
 * accumulated state. The real runner relies on that merge-and-return
 * behavior (it never keeps its own copy of persisted fields), so a stub that
 * just resolves `null` would let bugs in the runner's persistence order pass
 * silently.
 */
export function makeDeps(options: {
  meeting: Meeting;
  personas?: Persona[];
  meetingTypes?: MeetingType[];
  org?: OrgSettings;
  callModel?: CallModelFn;
  requestCreatorTurn?: RunMeetingDeps['requestCreatorTurn'];
  refreshDriveKnowledge?: RunMeetingDeps['refreshDriveKnowledge'];
  fetchDriveDeepReadFile?: RunMeetingDeps['fetchDriveDeepReadFile'];
}): TestDeps {
  let current = options.meeting;
  const patches: Partial<Meeting>[] = [];

  return {
    patches,
    callModel:
      options.callModel ??
      (async () => {
        throw new Error('makeDeps: no callModel stub was provided');
      }),
    async updateMeeting(id, patch) {
      if (id !== current.id) return null;
      patches.push(patch);
      current = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      return current;
    },
    async getMeeting(id) {
      return id === current.id ? current : null;
    },
    async getPersonas() {
      return options.personas ?? [];
    },
    async getMeetingTypes() {
      return options.meetingTypes ?? [];
    },
    async getOrgSettings() {
      return options.org ?? makeOrg();
    },
    requestCreatorTurn: options.requestCreatorTurn,
    refreshDriveKnowledge: options.refreshDriveKnowledge,
    fetchDriveDeepReadFile: options.fetchDriveDeepReadFile,
  };
}

export function makeCallModelResult(overrides: Partial<CallModelResult> = {}): CallModelResult {
  return {
    text: '',
    webSearches: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    refused: false,
    truncated: false,
    ...overrides,
  };
}

/**
 * Plays back `responses` in call order; throws once exhausted so a test
 * expecting "callModel is not called again" fails loudly instead of the stub
 * quietly returning undefined.
 */
export function scriptedCallModel(responses: CallModelResult[]): CallModelFn & { calls: number } {
  let i = 0;
  const fn = Object.assign(
    async () => {
      if (i >= responses.length) {
        throw new Error(`scriptedCallModel: no response left for call #${i + 1}`);
      }
      const result = responses[i];
      i += 1;
      fn.calls = i;
      return result;
    },
    { calls: 0 }
  );
  return fn;
}
