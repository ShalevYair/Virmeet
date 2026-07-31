import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { Meeting, MeetingType, OrgSettings, Persona } from '../types';
import { CallModelOptions, CallModelResult, CallModelUsage } from '../anthropic';
import { EXTRACTION_SCHEMA, OPENING_SCHEMA, PREP_SCHEMA } from './schemas';
import { MeetingEvent, RunMeetingDeps } from './types';
import { runMeeting } from './runner';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePersona(overrides: Partial<Persona> = {}): Persona {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'פרסונה',
    role: 'תפקיד',
    organization: 'ארגון',
    color: '#000000',
    prompt: 'פרומפט פרסונה',
    model: 'test-persona-model',
    webAccess: false,
    maxApiCalls: 20,
    maxWebSearches: 0,
    files: [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMeetingType(overrides: Partial<MeetingType> = {}): MeetingType {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: 'סוג פגישה',
    shortDescription: 'תיאור קצר',
    prompt: 'פרומפט סוג פגישה',
    isBuiltIn: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeOrg(): OrgSettings {
  return {
    organizationName: 'ארגון בדיקה',
    description: 'תיאור',
    constraints: 'אילוצים',
    updatedAt: new Date().toISOString(),
  };
}

function makeMeeting(participantIds: string[], meetingTypeIds: string[], overrides: Partial<Meeting> = {}): Meeting {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: 'פגישת בדיקה',
    meetingTypeIds,
    objective: 'מטרת בדיקה',
    participantIds,
    files: [],
    discussionRounds: 1,
    status: 'draft',
    transcript: [],
    result: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function usage(): CallModelUsage {
  return { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 };
}

function okResult(text: string): CallModelResult {
  return { text, webSearches: [], usage: usage(), refused: false, stopReason: 'end_turn' };
}

const PREP_JSON = JSON.stringify({
  understanding: 'הבנה',
  concerns: ['חשש 1', 'חשש 2', 'חשש 3'],
  questions: ['שאלה 1', 'שאלה 2', 'שאלה 3'],
});

const OPENING_JSON = JSON.stringify({
  framing: 'מסגור',
  conflicts: [
    { topic: 'נושא א', sides: 'צד 1 מול צד 2', whoDisagrees: ['פרסונה א'] },
    { topic: 'נושא ב', sides: 'צד 3 מול צד 4', whoDisagrees: ['פרסונה ב'] },
  ],
});

function extractionJson(ownerName: string): string {
  return JSON.stringify({
    summary: 'סיכום הפגישה',
    decisions: ['החלטה 1'],
    openQuestions: [{ question: 'שאלה פתוחה', whoShouldAnswer: ownerName, blocking: false }],
    conflicts: [{ topic: 'נושא', sides: 'תיאור' }],
    risks: ['סיכון 1'],
    tasks: [
      {
        title: 'משימה 1',
        description: 'תיאור המשימה',
        ownerName,
        priority: 'high',
        dependsOn: [],
        assumption: 'הנחה',
        riskIfAssumptionWrong: 'סיכון אם ההנחה שגויה',
      },
    ],
    modelAssumptions: ['הנחת מודל'],
  });
}

/** Fake callModel that resolves every phase with a valid, schema-conforming response. */
function happyPathCallModel(ownerName: string): (opts: CallModelOptions) => Promise<CallModelResult> {
  return async (opts) => {
    if (opts.jsonSchema === PREP_SCHEMA) return okResult(PREP_JSON);
    if (opts.jsonSchema === OPENING_SCHEMA) return okResult(OPENING_JSON);
    if (opts.jsonSchema === EXTRACTION_SCHEMA) return okResult(extractionJson(ownerName));
    return okResult('תגובה חופשית');
  };
}

function makeDeps(
  meeting: Meeting,
  personas: Persona[],
  meetingTypes: MeetingType[],
  callModel: (opts: CallModelOptions) => Promise<CallModelResult>
): { deps: RunMeetingDeps; getCurrent: () => Meeting } {
  let current = meeting;
  const deps: RunMeetingDeps = {
    callModel,
    updateMeeting: async (_id, patch) => {
      current = { ...current, ...patch };
      return current;
    },
    getMeeting: async () => current,
    getPersonas: async () => personas,
    getMeetingTypes: async () => meetingTypes,
    getOrgSettings: async () => makeOrg(),
  };
  return { deps, getCurrent: () => current };
}

async function run(deps: RunMeetingDeps, meetingId: string): Promise<MeetingEvent[]> {
  const events: MeetingEvent[] = [];
  await runMeeting(meetingId, (e) => events.push(e), deps);
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMeeting', () => {
  it('happy path: two personas, one round, valid output at every phase -> completed', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id], { discussionRounds: 1 });

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], happyPathCallModel(a.name));
    const events = await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('completed');
    expect(final.result).not.toBeNull();
    expect(final.result?.tasks).toHaveLength(1);
    expect(final.result?.tasks[0].ownerPersonaId).toBe(a.id);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();

    // prep(2) + opening(1) + discussion(2, one round) + convergence(1) = 6 transcript entries.
    expect(final.transcript).toHaveLength(6);
    expect(final.transcript.filter((e) => e.phase === 'prep')).toHaveLength(2);
    expect(final.transcript.filter((e) => e.phase === 'discussion')).toHaveLength(2);

    // prep(2) + opening(1) + discussion(2) + convergence(1) + extraction(1) = 7 model calls.
    expect(final.usage.apiCalls).toBe(7);
  });

  it('a single persona failing in prep is logged and the meeting continues', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id]);

    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      if (opts.jsonSchema === PREP_SCHEMA && opts.model === 'model-a') {
        throw new Error('בעיית רשת');
      }
      return happyPathCallModel(b.name)(opts);
    };

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], callModel);
    await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('completed');
    const prepEntries = final.transcript.filter((e) => e.phase === 'prep');
    expect(prepEntries).toHaveLength(2);
    const systemLine = prepEntries.find((e) => e.speakerId === 'system');
    expect(systemLine?.text).toContain('פרסונה א');
    expect(systemLine?.text).toContain('בעיית רשת');
  });

  it('a refusal from a persona in prep is logged and the meeting continues', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id]);

    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      if (opts.jsonSchema === PREP_SCHEMA && opts.model === 'model-a') {
        return { text: '', webSearches: [], usage: usage(), refused: true, stopReason: 'refusal' };
      }
      return happyPathCallModel(b.name)(opts);
    };

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], callModel);
    await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('completed');
    const prepEntries = final.transcript.filter((e) => e.phase === 'prep');
    const systemLine = prepEntries.find((e) => e.speakerId === 'system');
    expect(systemLine?.text).toContain('פרסונה א');
    expect(systemLine?.text).toContain('סירב');
  });

  it('invalid JSON from prep is logged and the persona is excluded from prep results', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id]);

    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      if (opts.jsonSchema === PREP_SCHEMA && opts.model === 'model-a') {
        return okResult('this is not json');
      }
      return happyPathCallModel(b.name)(opts);
    };

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], callModel);
    await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('completed');
    const prepEntries = final.transcript.filter((e) => e.phase === 'prep');
    const systemLine = prepEntries.find((e) => e.speakerId === 'system');
    expect(systemLine?.text).toContain('פרסונה א');
    expect(systemLine?.text).toContain('JSON');
    // The persona with bad JSON never got a normal transcript entry for prep.
    expect(prepEntries.find((e) => e.speakerId === a.id)).toBeUndefined();
    expect(prepEntries.find((e) => e.speakerId === b.id)).toBeDefined();
  });

  it('exhausting a persona budget skips it in later rounds and announces exactly once', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a', maxApiCalls: 1 });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b', maxApiCalls: 10 });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id], { discussionRounds: 2 });

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], happyPathCallModel(b.name));
    await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('completed');

    const discussionEntries = final.transcript.filter((e) => e.phase === 'discussion');
    // persona a is exhausted right after prep (maxApiCalls: 1), so it never speaks in discussion.
    expect(discussionEntries.filter((e) => e.speakerId === a.id)).toHaveLength(0);
    // persona b speaks in both rounds.
    expect(discussionEntries.filter((e) => e.speakerId === b.id)).toHaveLength(2);

    const budgetMessages = discussionEntries.filter(
      (e) => e.speakerId === 'system' && e.text.includes('פרסונה א') && e.text.includes('תקציב')
    );
    expect(budgetMessages).toHaveLength(1);
  });

  it('a max_tokens-truncated extraction reports the truncation, not a JSON parse error', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id]);

    let extractionMaxTokensSeen: number | undefined;
    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      if (opts.jsonSchema === EXTRACTION_SCHEMA) {
        extractionMaxTokensSeen = opts.maxTokens;
        return {
          text: '{"summary": "סיכום חלקי שנקטע באמצ',
          webSearches: [],
          usage: usage(),
          refused: false,
          stopReason: 'max_tokens',
        };
      }
      return happyPathCallModel(a.name)(opts);
    };

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], callModel);
    await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('failed');
    expect(final.error).toContain('נקטע');
    expect(final.error).not.toContain('JSON');
    expect(extractionMaxTokensSeen).toBe(32000);
  });

  it('an extraction failure marks the meeting failed but keeps the transcript', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id]);

    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      if (opts.jsonSchema === EXTRACTION_SCHEMA) {
        throw new Error('נכשל בחילוץ');
      }
      return happyPathCallModel(a.name)(opts);
    };

    const { deps, getCurrent } = makeDeps(meeting, [a, b], [mt], callModel);
    const events = await run(deps, meeting.id);

    const final = getCurrent();
    expect(final.status).toBe('failed');
    expect(final.error).toContain('נכשל בחילוץ');
    expect(final.result).toBeNull();
    // Transcript from prep/opening/discussion/convergence survives the extraction failure.
    expect(final.transcript.length).toBeGreaterThan(0);
    expect(final.transcript.some((e) => e.phase === 'convergence')).toBe(true);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('sends the meeting header as its own cached content block, identical across every call', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id], {
      files: [
        {
          id: randomUUID(),
          name: 'רקע.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
          storedPath: 'uploads/x',
          extractedText: 'תוכן קובץ הרקע המשותף',
          addedAt: new Date().toISOString(),
        },
      ],
    });

    const seenHeaders: unknown[] = [];
    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      const content = opts.messages[0]?.content;
      if (Array.isArray(content)) seenHeaders.push(content[0]);
      return happyPathCallModel(a.name)(opts);
    };

    const { deps } = makeDeps(meeting, [a, b], [mt], callModel);
    await run(deps, meeting.id);

    // prep(2) + opening(1) + discussion(2) + convergence(1) + extraction(1) = 7 calls.
    expect(seenHeaders).toHaveLength(7);
    for (const header of seenHeaders) {
      expect(header).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
      expect((header as { text: string }).text).toContain('תוכן קובץ הרקע המשותף');
    }
    const distinctHeaderTexts = new Set(seenHeaders.map((h) => (h as { text: string }).text));
    expect(distinctHeaderTexts.size).toBe(1);
  });

  it('stops promptly once cancelled mid-discussion, preserving the transcript and making no further calls', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const b = makePersona({ name: 'פרסונה ב', model: 'model-b' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id, b.id], [mt.id], { discussionRounds: 3 });

    let current = meeting;
    let discussionCalls = 0;
    const callModel = async (opts: CallModelOptions): Promise<CallModelResult> => {
      const isDiscussionCall = !opts.jsonSchema && (opts.model === 'model-a' || opts.model === 'model-b');
      if (isDiscussionCall) {
        discussionCalls += 1;
        if (discussionCalls === 2) {
          // Simulate the user's cancel PATCH landing right as round 1 finishes.
          current = { ...current, status: 'cancelled' };
        }
      }
      return happyPathCallModel(a.name)(opts);
    };

    const deps: RunMeetingDeps = {
      callModel,
      updateMeeting: async (_id, patch) => {
        current = { ...current, ...patch };
        return current;
      },
      getMeeting: async () => current,
      getPersonas: async () => [a, b],
      getMeetingTypes: async () => [mt],
      getOrgSettings: async () => makeOrg(),
    };

    await run(deps, meeting.id);

    expect(current.status).toBe('cancelled');
    // Only round 1 (both personas) got through before cancellation was noticed.
    expect(discussionCalls).toBe(2);
    const discussionSpeakerEntries = current.transcript.filter(
      (e) => e.phase === 'discussion' && (e.speakerId === a.id || e.speakerId === b.id)
    );
    expect(discussionSpeakerEntries).toHaveLength(2);
    expect(current.transcript.some((e) => e.speakerId === 'system' && e.text.includes('בוטלה'))).toBe(true);
    // No convergence/extraction entries — the run stopped, it didn't just skip ahead.
    expect(current.transcript.some((e) => e.phase === 'convergence')).toBe(false);
    expect(current.result).toBeNull();
  });

  it('refuses to run with fewer than two participants and makes no model calls', async () => {
    const a = makePersona({ name: 'פרסונה א', model: 'model-a' });
    const mt = makeMeetingType();
    const meeting = makeMeeting([a.id], [mt.id]);

    const callModel = vi.fn(happyPathCallModel(a.name));
    const { deps } = makeDeps(meeting, [a], [mt], callModel);
    const events = await run(deps, meeting.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(callModel).not.toHaveBeenCalled();
  });
});
