import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { runMeeting } from '../engine/runner';
import { RunMeetingDeps } from '../engine/types';
import { CallModelOptions, CallModelResult } from '../anthropic';
import { Meeting, MeetingType, OrgSettings, Persona } from '../types';

function makePersona(id: string, name: string, overrides: Partial<Persona> = {}): Persona {
  return {
    id,
    name,
    role: 'role',
    organization: 'org',
    color: '#000',
    prompt: `prompt-of-${id}`,
    model: 'claude-sonnet-5',
    webAccess: false,
    maxApiCalls: 20,
    maxWebSearches: 0,
    files: [],
    isActive: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const MEETING_TYPE: MeetingType = {
  id: 't1',
  title: 'type',
  shortDescription: 'x',
  prompt: 'y',
  isBuiltIn: true,
  createdAt: '',
  updatedAt: '',
};

function makeOrg(overrides: Partial<OrgSettings> = {}): OrgSettings {
  return {
    organizationName: 'org',
    description: 'd',
    constraints: 'c',
    maxMeetingApiCalls: 100,
    maxMeetingTokens: 10_000_000,
    updatedAt: '',
    ...overrides,
  };
}

function makeMeeting(id: string, participantIds: string[], overrides: Partial<Meeting> = {}): Meeting {
  const now = new Date().toISOString();
  return {
    id,
    title: 'test',
    meetingTypeIds: ['t1'],
    objective: 'obj',
    participantIds,
    files: [],
    discussionRounds: 2,
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

/** In-memory harness standing in for the store: a single mutable meeting record. */
function makeHarness(personas: Persona[], meeting: Meeting) {
  let stored: Meeting = meeting;
  const deps: Partial<RunMeetingDeps> = {
    getMeeting: async (id) => (id === stored.id ? { ...stored } : null),
    updateMeeting: async (_id, patch) => {
      stored = { ...stored, ...patch, updatedAt: new Date().toISOString() };
      return { ...stored };
    },
    getPersonas: async () => personas,
    getMeetingTypes: async () => [MEETING_TYPE],
    getOrgSettings: async () => makeOrg(),
  };
  return {
    deps,
    getStored: () => stored,
  };
}

function isPrepCall(opts: CallModelOptions): boolean {
  return Array.isArray(opts.jsonSchema?.required) && (opts.jsonSchema!.required as string[]).includes('understanding');
}

function isExtractionCall(opts: CallModelOptions): boolean {
  return Array.isArray(opts.jsonSchema?.required) && (opts.jsonSchema!.required as string[]).includes('tasks');
}

/** True for a persona's free-text discussion-phase call (no jsonSchema, persona's own prompt as system[1]). */
function isDiscussionCallFor(opts: CallModelOptions, personaPrompt: string): boolean {
  return !opts.jsonSchema && opts.system[1]?.text === personaPrompt;
}

function structuredOk(opts: CallModelOptions): CallModelResult {
  const payload = {
    understanding: 'u',
    concerns: ['c1', 'c2', 'c3'],
    questions: ['q1', 'q2', 'q3'],
    framing: 'f',
    conflicts: [],
    summary: 's',
    decisions: [],
    openQuestions: [],
    risks: [],
    modelAssumptions: [],
    tasks: [],
  };
  return {
    text: opts.jsonSchema ? JSON.stringify(payload) : 'free-text discussion turn',
    webSearches: [],
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 },
    refused: false,
  };
}

describe('runMeeting — happy path', () => {
  it('runs prep -> opening -> discussion -> convergence -> extraction and completes with a result', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1 });
    const { deps, getStored } = makeHarness(personas, meeting);

    const phases: string[] = [];
    let doneResult: unknown = null;

    await runMeeting(
      'm1',
      (evt) => {
        if (evt.type === 'phase') phases.push(evt.phase);
        if (evt.type === 'done') doneResult = evt.result;
      },
      { ...deps, callModel: async (opts) => structuredOk(opts) }
    );

    expect(phases).toEqual(['prep', 'opening', 'discussion', 'convergence', 'extraction']);
    expect(getStored().status).toBe('completed');
    expect(getStored().result).not.toBeNull();
    expect(doneResult).not.toBeNull();
    // 2 prep + 1 opening + 2 discussion (1 round) + 1 convergence + 1 extraction = 7
    expect(getStored().usage.apiCalls).toBe(7);
  });
});

describe('runMeeting — one persona fails mid-discussion', () => {
  it('logs a system error line and the discussion continues with the other persona', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1 });
    const { deps, getStored } = makeHarness(personas, meeting);

    await runMeeting(
      'm1',
      () => {},
      {
        ...deps,
        callModel: async (opts) => {
          if (isDiscussionCallFor(opts, 'prompt-of-p1')) {
            throw new Error('boom');
          }
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    expect(finalMeeting.status).toBe('completed');
    const systemLines = finalMeeting.transcript.filter((e) => e.speakerId === 'system');
    expect(systemLines.some((e) => e.text.includes('אירעה שגיאה בקבלת תגובה מ-Alice'))).toBe(true);

    // Bob's discussion entry must still be present despite Alice's failure.
    const bobEntries = finalMeeting.transcript.filter((e) => e.speakerId === 'p2' && e.phase === 'discussion');
    expect(bobEntries.length).toBe(1);
    const aliceEntries = finalMeeting.transcript.filter((e) => e.speakerId === 'p1' && e.phase === 'discussion');
    expect(aliceEntries.length).toBe(0);
  });
});

describe('runMeeting — refusal in prep', () => {
  it('logs a refusal line for that persona and the meeting still completes', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1 });
    const { deps, getStored } = makeHarness(personas, meeting);

    await runMeeting(
      'm1',
      () => {},
      {
        ...deps,
        callModel: async (opts) => {
          if (isPrepCall(opts) && opts.system[1]?.text === 'prompt-of-p1') {
            return {
              text: '',
              webSearches: [],
              usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 },
              refused: true,
            };
          }
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    expect(finalMeeting.status).toBe('completed');
    const refusalLines = finalMeeting.transcript.filter((e) => e.phase === 'prep' && e.text.includes('סירב'));
    expect(refusalLines).toHaveLength(1);
    expect(refusalLines[0].text).toContain('Alice');
    // Bob's prep still went through normally.
    const bobPrep = finalMeeting.transcript.filter((e) => e.speakerId === 'p2' && e.phase === 'prep');
    expect(bobPrep).toHaveLength(1);
  });
});

describe('runMeeting — extraction failure', () => {
  it('marks the meeting failed but keeps the transcript accumulated so far', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1 });
    const { deps, getStored } = makeHarness(personas, meeting);

    await runMeeting(
      'm1',
      () => {},
      {
        ...deps,
        callModel: async (opts) => {
          if (isExtractionCall(opts)) {
            throw new Error('extraction blew up');
          }
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    expect(finalMeeting.status).toBe('failed');
    expect(finalMeeting.error).toContain('extraction blew up');
    expect(finalMeeting.result).toBeNull();
    // Transcript from prep/opening/discussion/convergence must survive the extraction failure.
    expect(finalMeeting.transcript.length).toBeGreaterThan(0);
    expect(finalMeeting.transcript.some((e) => e.phase === 'discussion')).toBe(true);
    expect(finalMeeting.transcript.some((e) => e.phase === 'convergence')).toBe(true);
  });
});

describe('runMeeting — per-persona budget enforcement', () => {
  it('skips a persona once their maxApiCalls is exhausted, with a one-time announcement', async () => {
    // Alice's budget: 1 call total (spent on prep) — no room for any discussion turn.
    const personas = [makePersona('p1', 'Alice', { maxApiCalls: 1 }), makePersona('p2', 'Bob', { maxApiCalls: 20 })];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 3 });
    const { deps, getStored } = makeHarness(personas, meeting);

    await runMeeting('m1', () => {}, { ...deps, callModel: async (opts) => structuredOk(opts) });

    const finalMeeting = getStored();
    const aliceDiscussionEntries = finalMeeting.transcript.filter((e) => e.speakerId === 'p1' && e.phase === 'discussion');
    expect(aliceDiscussionEntries).toHaveLength(0);

    const exhaustedLines = finalMeeting.transcript.filter((e) => e.text.includes('הגיע/ה לתקציב הקריאות'));
    // Announced exactly once, not once per round.
    expect(exhaustedLines).toHaveLength(1);

    const bobDiscussionEntries = finalMeeting.transcript.filter((e) => e.speakerId === 'p2' && e.phase === 'discussion');
    expect(bobDiscussionEntries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// P3.3 — regression tests for stage 1 (P1.1 cancellation, P1.2 error mapping)
// ---------------------------------------------------------------------------

describe('runMeeting — cancellation (P1.1 regression)', () => {
  it('stops within one turn, keeps the transcript, and does not let a later emitPhase revive the run', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 4 });
    const { deps, getStored } = makeHarness(personas, meeting);

    let callCount = 0;
    const events: string[] = [];

    await runMeeting(
      'm1',
      (evt) => events.push(evt.type),
      {
        ...deps,
        callModel: async (opts) => {
          callCount += 1;
          // Cancel right after the opening call — mimics a PATCH landing between calls.
          if (callCount === 3) {
            await deps.updateMeeting!('m1', { status: 'cancelled' });
          }
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    expect(finalMeeting.status).toBe('cancelled');
    expect(events).toContain('cancelled');

    const lastEntry = finalMeeting.transcript[finalMeeting.transcript.length - 1];
    expect(lastEntry.speakerId).toBe('system');
    expect(lastEntry.text).toBe('הפגישה בוטלה על ידי המשתמש.');

    // Discussion never actually started — cancellation was caught before the first turn.
    const discussionEntries = finalMeeting.transcript.filter((e) => e.phase === 'discussion' && e.speakerId !== 'system');
    expect(discussionEntries).toHaveLength(0);

    // No further callModel invocations happened after the cancellation was detected.
    expect(callCount).toBe(3);
  });
});

describe('runMeeting — Hebrew error mapping (P1.2 regression)', () => {
  it('maps a timeout error to a Hebrew system line instead of the raw SDK text', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1 });
    const { deps, getStored } = makeHarness(personas, meeting);

    await runMeeting(
      'm1',
      () => {},
      {
        ...deps,
        callModel: async (opts) => {
          if (isDiscussionCallFor(opts, 'prompt-of-p1')) {
            throw new Anthropic.APIConnectionTimeoutError();
          }
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    const errorLine = finalMeeting.transcript.find((e) => e.speakerId === 'system' && e.text.includes('Alice'));
    expect(errorLine?.text).toContain('הקריאה למודל חרגה מזמן ההמתנה המותר');
    // The raw SDK text ("Request timed out.") must never leak into the transcript.
    expect(errorLine?.text).not.toContain('Request timed out');
  });
});
