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

/** True for a facilitated-mode (P8) round-planning call — the only schema with a `speakers` field. */
function isRoundPlanCall(opts: CallModelOptions): boolean {
  return Array.isArray(opts.jsonSchema?.required) && (opts.jsonSchema!.required as string[]).includes('speakers');
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

describe('runMeeting — extraction data hygiene (P4.1/P4.2 regression)', () => {
  it('does not silently drop a task owner match, and flags an unrecognized name or dangling dependsOn', async () => {
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
            return {
              text: JSON.stringify({
                summary: 's',
                decisions: [],
                openQuestions: [],
                conflicts: [],
                risks: [],
                modelAssumptions: [],
                tasks: [
                  {
                    title: 'task-a',
                    description: 'd',
                    ownerName: 'Alice', // exact match — must resolve cleanly
                    priority: 'medium',
                    dependsOn: [],
                    assumption: 'a',
                    riskIfAssumptionWrong: 'r',
                  },
                  {
                    title: 'task-b',
                    description: 'd',
                    ownerName: 'Alicia', // close-but-not-identical — must NOT silently resolve
                    priority: 'low',
                    dependsOn: ['task-a', 'task-does-not-exist'],
                    assumption: 'a',
                    riskIfAssumptionWrong: 'r',
                  },
                ],
              }),
              webSearches: [],
              usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 },
              refused: false,
            };
          }
          return structuredOk(opts);
        },
      }
    );

    const result = getStored().result;
    expect(result).not.toBeNull();

    const taskA = result!.tasks.find((t) => t.title === 'task-a')!;
    expect(taskA.ownerPersonaId).toBe('p1');

    const taskB = result!.tasks.find((t) => t.title === 'task-b')!;
    expect(taskB.ownerPersonaId).toBeNull();
    expect(taskB.ownerName).toBe('Alicia'); // preserved verbatim for display, even though unresolved
    expect(taskB.dependsOn).toEqual(['task-a']); // the dangling reference was filtered out

    expect(result!.modelAssumptions.some((a) => a.includes('שם לא מוכר') && a.includes('Alicia'))).toBe(true);
    expect(result!.modelAssumptions.some((a) => a.includes('task-does-not-exist'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P8 (ניסיוני) — discussionMode:'facilitated'
// ---------------------------------------------------------------------------

describe('runMeeting — discussionMode facilitated (P8, ניסיוני)', () => {
  it('asks the facilitator for a per-round plan, skips personas it omits, and threads the focus question into the discussion call', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 2, discussionMode: 'facilitated' });
    const { deps, getStored } = makeHarness(personas, meeting);

    const focusQuestionsSeen: string[] = [];
    let roundPlanCalls = 0;

    await runMeeting(
      'm1',
      () => {},
      {
        ...deps,
        callModel: async (opts) => {
          if (isRoundPlanCall(opts)) {
            roundPlanCalls += 1;
            const content = opts.messages[0].content as string;
            const round1 = content.includes('סבב 1 מתוך 2');
            const speakers = round1
              ? [{ name: 'Alice', focusQuestion: 'שאלה לסבב 1' }]
              : [{ name: 'Bob', focusQuestion: 'שאלה לסבב 2' }];
            return {
              text: JSON.stringify({ speakers }),
              webSearches: [],
              usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 },
              refused: false,
            };
          }
          if (isDiscussionCallFor(opts, 'prompt-of-p1') || isDiscussionCallFor(opts, 'prompt-of-p2')) {
            const block = opts.messages[0].content;
            if (Array.isArray(block)) {
              const instructionText = (block[1] as { text: string }).text;
              if (instructionText.includes('שאלה לסבב')) focusQuestionsSeen.push(instructionText);
            }
          }
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    expect(finalMeeting.status).toBe('completed');
    // One planning call per round.
    expect(roundPlanCalls).toBe(2);

    // Round 1: only Alice speaks (per the plan); Bob is skipped with a Hebrew line naming him.
    const round1AliceEntries = finalMeeting.transcript.filter(
      (e) => e.speakerId === 'p1' && e.phase === 'discussion' && e.round === 1
    );
    expect(round1AliceEntries).toHaveLength(1);
    const round1BobEntries = finalMeeting.transcript.filter(
      (e) => e.speakerId === 'p2' && e.phase === 'discussion' && e.round === 1
    );
    expect(round1BobEntries).toHaveLength(0);
    const round1BobSkip = finalMeeting.transcript.find(
      (e) => e.speakerId === 'system' && e.round === 1 && e.text.includes('Bob') && e.text.includes('לא נבחר/ה')
    );
    expect(round1BobSkip).toBeDefined();

    // Round 2: only Bob speaks; Alice is skipped.
    const round2BobEntries = finalMeeting.transcript.filter(
      (e) => e.speakerId === 'p2' && e.phase === 'discussion' && e.round === 2
    );
    expect(round2BobEntries).toHaveLength(1);
    const round2AliceSkip = finalMeeting.transcript.find(
      (e) => e.speakerId === 'system' && e.round === 2 && e.text.includes('Alice') && e.text.includes('לא נבחר/ה')
    );
    expect(round2AliceSkip).toBeDefined();

    // The facilitator's focused question actually reached the discussion instruction block.
    expect(focusQuestionsSeen.some((t) => t.includes('שאלה לסבב 1'))).toBe(true);
    expect(focusQuestionsSeen.some((t) => t.includes('שאלה לסבב 2'))).toBe(true);
  });

  it('falls back to round-robin for a round when the planning call fails, instead of dropping the round', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];
    const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1, discussionMode: 'facilitated' });
    const { deps, getStored } = makeHarness(personas, meeting);

    await runMeeting(
      'm1',
      () => {},
      {
        ...deps,
        callModel: async (opts) => {
          if (isRoundPlanCall(opts)) throw new Error('planning call boom');
          return structuredOk(opts);
        },
      }
    );

    const finalMeeting = getStored();
    expect(finalMeeting.status).toBe('completed');
    // Both personas still got a turn — no skip lines, no dropped round.
    const discussionSpeakers = finalMeeting.transcript
      .filter((e) => e.phase === 'discussion' && e.speakerId !== 'system')
      .map((e) => e.speakerId);
    expect(discussionSpeakers.sort()).toEqual(['p1', 'p2']);
    const skipLines = finalMeeting.transcript.filter((e) => e.text.includes('לא נבחר/ה'));
    expect(skipLines).toHaveLength(0);
  });
});

describe('runMeeting — discussionMode round-robin unchanged (P8 regression)', () => {
  it('produces the same call count and phases whether discussionMode is omitted or explicitly round-robin', async () => {
    const personas = [makePersona('p1', 'Alice'), makePersona('p2', 'Bob')];

    async function run(discussionMode?: 'round-robin' | 'facilitated') {
      const meeting = makeMeeting('m1', ['p1', 'p2'], { discussionRounds: 1, discussionMode });
      const { deps, getStored } = makeHarness(personas, meeting);
      const phases: string[] = [];
      await runMeeting(
        'm1',
        (evt) => {
          if (evt.type === 'phase') phases.push(evt.phase);
        },
        { ...deps, callModel: async (opts) => structuredOk(opts) }
      );
      return { finalMeeting: getStored(), phases };
    }

    const omitted = await run(undefined);
    const explicit = await run('round-robin');

    expect(omitted.phases).toEqual(explicit.phases);
    // 2 prep + 1 opening + 2 discussion (1 round, no planning calls) + 1 convergence + 1 extraction = 7
    expect(omitted.finalMeeting.usage.apiCalls).toBe(7);
    expect(explicit.finalMeeting.usage.apiCalls).toBe(7);
    expect(omitted.finalMeeting.transcript.filter((e) => e.text.includes('לא נבחר/ה'))).toHaveLength(0);
    expect(explicit.finalMeeting.transcript.filter((e) => e.text.includes('לא נבחר/ה'))).toHaveLength(0);
  });
});
