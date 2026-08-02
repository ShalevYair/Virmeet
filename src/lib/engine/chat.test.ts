import { describe, expect, it } from 'vitest';
import { askGeneralChatQuestion, askPersonaChatQuestion, runAdditionalDiscussionRound } from './chat';
import { makeCallModelResult, makeDeps, makeMeeting, makePersona, scriptedCallModel } from './__tests__/helpers';
import type { Meeting, TranscriptEntry } from '../types';

const p1 = makePersona({ name: 'עידית', role: 'ארכיטקטית' });
const p2 = makePersona({ name: 'רון', role: 'מנהל מוצר', webAccess: true, maxWebSearches: 3 });

function completedMeeting(overrides: Partial<Meeting> = {}) {
  return makeMeeting({
    status: 'completed',
    participantIds: [p1.id, p2.id],
    result: {
      summary: 'סוכם להמשיך בשלב הבא',
      decisions: [],
      openQuestions: [],
      conflicts: [],
      risks: [],
      tasks: [],
      modelAssumptions: [],
    },
    ...overrides,
  });
}

describe('askGeneralChatQuestion', () => {
  it('rejects when the meeting has not completed', async () => {
    const meeting = completedMeeting({ status: 'running' });
    const deps = makeDeps({ meeting, personas: [p1, p2] });
    await expect(askGeneralChatQuestion(meeting.id, 'שאלה', deps)).rejects.toThrow('הסתיימה');
  });

  it('answers via the facilitator, persists the exchange onto chat, and accumulates usage', async () => {
    const meeting = completedMeeting();
    const callModel = scriptedCallModel([
      makeCallModelResult({
        text: 'התשובה הכללית',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 },
      }),
    ]);
    const deps = makeDeps({ meeting, personas: [p1, p2], callModel });

    const message = await askGeneralChatQuestion(meeting.id, 'מה סוכם?', deps);

    expect(message.mode).toBe('general');
    expect(message.answer).toBe('התשובה הכללית');
    expect(message.refused).toBeUndefined();

    const finalPatch = deps.patches.at(-1);
    expect(finalPatch?.chat).toEqual([message]);
    expect(finalPatch?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      apiCalls: 1,
    });
  });

  it('records a refusal as an empty answer instead of throwing', async () => {
    const meeting = completedMeeting();
    const callModel = scriptedCallModel([makeCallModelResult({ refused: true })]);
    const deps = makeDeps({ meeting, personas: [p1, p2], callModel });

    const message = await askGeneralChatQuestion(meeting.id, 'שאלה', deps);

    expect(message.answer).toBe('');
    expect(message.refused).toBe(true);
  });

  it('only feeds this thread its own prior general turns, not persona-directed ones', async () => {
    const priorGeneral = {
      id: 'c1',
      mode: 'general' as const,
      question: 'שאלה כללית קודמת',
      answer: 'תשובה קודמת',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const priorPersona = {
      id: 'c2',
      mode: 'persona' as const,
      personaId: p1.id,
      question: 'שאלה לעידית',
      answer: 'תשובת עידית',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const meeting = completedMeeting({ chat: [priorGeneral, priorPersona] });
    let capturedContent = '';
    const callModel = scriptedCallModel([makeCallModelResult({ text: 'עוד תשובה' })]);
    const deps = makeDeps({
      meeting,
      personas: [p1, p2],
      callModel: async (opts) => {
        capturedContent = opts.messages[0].content;
        return callModel(opts);
      },
    });

    await askGeneralChatQuestion(meeting.id, 'שאלה נוספת', deps);

    expect(capturedContent).toContain('שאלה כללית קודמת');
    expect(capturedContent).not.toContain('שאלה לעידית');
  });
});

describe('askPersonaChatQuestion', () => {
  it('rejects when the chosen persona is not a participant of this meeting', async () => {
    const outsider = makePersona({ name: 'לא משתתף' });
    const meeting = completedMeeting();
    const deps = makeDeps({ meeting, personas: [p1, p2, outsider] });
    await expect(askPersonaChatQuestion(meeting.id, outsider.id, 'שאלה', deps)).rejects.toThrow('אינו חלק');
  });

  it("answers in that persona's voice and forwards their webAccess settings", async () => {
    const meeting = completedMeeting();
    let sawWebSearch: unknown;
    const deps = makeDeps({
      meeting,
      personas: [p1, p2],
      callModel: async (opts) => {
        sawWebSearch = opts.webSearch;
        return makeCallModelResult({ text: 'תשובת רון' });
      },
    });

    const message = await askPersonaChatQuestion(meeting.id, p2.id, 'מה דעתך?', deps);

    expect(message.mode).toBe('persona');
    expect(message.personaId).toBe(p2.id);
    expect(message.answer).toBe('תשובת רון');
    expect(sawWebSearch).toEqual({ maxUses: 3 });
  });
});

describe('runAdditionalDiscussionRound', () => {
  it('numbers the new round after the highest existing round and lets every participant speak once', async () => {
    const existingEntry: TranscriptEntry = {
      id: 'e1',
      phase: 'discussion',
      speakerId: p1.id,
      speakerName: p1.name,
      round: 2,
      text: 'משהו שנאמר בסבב המקורי',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const meeting = completedMeeting({ transcript: [existingEntry], discussionRounds: 2 });
    const callModel = scriptedCallModel([
      makeCallModelResult({ text: 'תגובת עידית לנושא החדש' }),
      makeCallModelResult({ text: 'תגובת רון לנושא החדש' }),
    ]);
    const deps = makeDeps({ meeting, personas: [p1, p2], callModel });
    const streamed: TranscriptEntry[] = [];

    const newEntries = await runAdditionalDiscussionRound(meeting.id, 'האם לצמצם תקציב?', deps, undefined, undefined, (e) =>
      streamed.push(e)
    );

    // system-topic line + one entry per participant
    expect(newEntries).toHaveLength(3);
    expect(newEntries[0].speakerId).toBe('system');
    expect(newEntries.slice(1).every((e) => e.round === 3)).toBe(true);
    expect(newEntries[1].text).toBe('תגובת עידית לנושא החדש');
    expect(newEntries[2].text).toBe('תגובת רון לנושא החדש');
    expect(streamed).toEqual(newEntries);

    const finalPatch = deps.patches.at(-1);
    expect(finalPatch?.discussionRounds).toBe(3);
    expect(finalPatch?.transcript).toEqual([existingEntry, ...newEntries]);
  });

  it('starts at round 1 when the meeting has no discussion entries yet', async () => {
    const meeting = completedMeeting({ transcript: [], discussionRounds: 0 });
    const callModel = scriptedCallModel([makeCallModelResult({ text: 'א' }), makeCallModelResult({ text: 'ב' })]);
    const deps = makeDeps({ meeting, personas: [p1, p2], callModel });

    const newEntries = await runAdditionalDiscussionRound(meeting.id, 'נושא', deps);

    expect(newEntries.slice(1).every((e) => e.round === 1)).toBe(true);
  });

  it('turns a per-persona call failure into a system line and keeps going', async () => {
    const meeting = completedMeeting({ transcript: [], discussionRounds: 1 });
    let calls = 0;
    const deps = makeDeps({
      meeting,
      personas: [p1, p2],
      callModel: async () => {
        calls += 1;
        if (calls === 1) throw new Error('בעיית רשת');
        return makeCallModelResult({ text: 'תגובת רון' });
      },
    });

    const newEntries = await runAdditionalDiscussionRound(meeting.id, 'נושא', deps);

    expect(newEntries[1].speakerId).toBe('system');
    expect(newEntries[1].text).toContain('בעיית רשת');
    expect(newEntries[2].speakerId).toBe(p2.id);
  });

  it('turns a refusal into a system line rather than a persona entry', async () => {
    const meeting = completedMeeting({ transcript: [], discussionRounds: 1 });
    const callModel = scriptedCallModel([
      makeCallModelResult({ refused: true }),
      makeCallModelResult({ text: 'תגובת רון' }),
    ]);
    const deps = makeDeps({ meeting, personas: [p1, p2], callModel });

    const newEntries = await runAdditionalDiscussionRound(meeting.id, 'נושא', deps);

    expect(newEntries[1].speakerId).toBe('system');
    expect(newEntries[2].speakerId).toBe(p2.id);
  });
});
