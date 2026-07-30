import { describe, expect, it } from 'vitest';
import type { Meeting } from '../types';
import { CallModelResult } from '../llm-types';
import {
  makeCallModelResult,
  makeDeps,
  makeMeeting,
  makeMeetingType,
  makeOrg,
  makePersona,
  scriptedCallModel,
} from './__tests__/helpers';
import { runMeeting } from './runner';
import type { MeetingEvent } from './types';

// A happy-path call sequence for a 2-participant, 1-round meeting:
// prep(p1), prep(p2), opening, discussion round1(p1), discussion round1(p2),
// convergence, extraction — 7 calls total, indices 0..6.
function validPrep(): CallModelResult {
  return makeCallModelResult({
    text: JSON.stringify({ understanding: 'u', concerns: ['a', 'b', 'c'], questions: ['a', 'b', 'c'] }),
  });
}
function validOpening(): CallModelResult {
  return makeCallModelResult({ text: JSON.stringify({ framing: 'f', conflicts: [] }) });
}
function validDiscussion(label: string): CallModelResult {
  return makeCallModelResult({ text: `דיון ${label}` });
}
function validConvergence(): CallModelResult {
  return makeCallModelResult({ text: 'סיכום התכנסות' });
}
function validExtraction(): CallModelResult {
  return makeCallModelResult({
    text: JSON.stringify({
      summary: 's',
      decisions: [],
      openQuestions: [],
      conflicts: [],
      risks: [],
      tasks: [],
      modelAssumptions: [],
    }),
  });
}

/** anthropic-style truncation: max_tokens cut a partial-but-nonempty response. */
function partialTruncated(): CallModelResult {
  return makeCallModelResult({ truncated: true, text: '{"understanding": "נקטע כאן' });
}

/** gemini-style truncation edge case: thinking ate the whole budget, text is empty. */
function emptyTruncated(): CallModelResult {
  return makeCallModelResult({ truncated: true, text: '' });
}

function happyPathResponses(): CallModelResult[] {
  return [
    validPrep(),
    validPrep(),
    validOpening(),
    validDiscussion('1'),
    validDiscussion('2'),
    validConvergence(),
    validExtraction(),
  ];
}

async function runWithResponses(responses: CallModelResult[]) {
  const p1 = makePersona({ name: 'א' });
  const p2 = makePersona({ name: 'ב' });
  const meetingType = makeMeetingType();
  const meeting = makeMeeting({
    participantIds: [p1.id, p2.id],
    meetingTypeIds: [meetingType.id],
    discussionRounds: 1,
    status: 'draft',
  });
  const deps = makeDeps({
    meeting,
    personas: [p1, p2],
    meetingTypes: [meetingType],
    org: makeOrg(),
    callModel: scriptedCallModel(responses),
  });

  const events: MeetingEvent[] = [];
  await runMeeting(meeting.id, (e) => events.push(e), deps, {});
  const finalMeeting = (await deps.getMeeting(meeting.id)) as Meeting;
  return { events, finalMeeting, personaNames: { p1: p1.name, p2: p2.name } };
}

describe.each([
  ['anthropic-style (partial text)', partialTruncated],
  ['gemini-style (empty text)', emptyTruncated],
])('truncated response in prep — %s', (_label, makeTruncated) => {
  it('logs a system line and excludes the persona from prep instead of crashing on JSON.parse', async () => {
    const responses = happyPathResponses();
    responses[0] = makeTruncated();
    const { events, finalMeeting, personaNames } = await runWithResponses(responses);

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const prepSystemLine = finalMeeting.transcript.find(
      (e) => e.phase === 'prep' && e.speakerId === 'system' && e.text.includes('נקטעה בשל מגבלת אורך')
    );
    expect(prepSystemLine?.text).toContain(personaNames.p1);
    expect(finalMeeting.status).toBe('completed');
  });
});

describe.each([
  ['anthropic-style (partial text)', partialTruncated],
  ['gemini-style (empty text)', emptyTruncated],
])('truncated response in opening — %s', (_label, makeTruncated) => {
  it('falls back to basic framing and logs a system line instead of crashing on JSON.parse', async () => {
    const responses = happyPathResponses();
    responses[2] = makeTruncated();
    const { events, finalMeeting } = await runWithResponses(responses);

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const openingSystemLine = finalMeeting.transcript.find(
      (e) => e.phase === 'opening' && e.speakerId === 'system' && e.text.includes('נקטעה בשל מגבלת אורך')
    );
    expect(openingSystemLine).toBeDefined();
    expect(finalMeeting.status).toBe('completed');
  });
});

describe.each([
  ['anthropic-style (partial text)', partialTruncated],
  ['gemini-style (empty text)', emptyTruncated],
])('truncated response in discussion — %s', (_label, makeTruncated) => {
  it("marks the transcript entry with a visible truncation notice instead of presenting it as a complete statement", async () => {
    const responses = happyPathResponses();
    const truncatedResult = makeTruncated();
    responses[3] = truncatedResult;
    const { finalMeeting } = await runWithResponses(responses);

    const discussionEntry = finalMeeting.transcript.find((e) => e.phase === 'discussion' && e.round === 1 && e.speakerId !== 'system');
    expect(discussionEntry?.text).toBe(`${truncatedResult.text}\n\n[הערת מערכת: התגובה נקטעה בשל מגבלת אורך]`);
  });
});

describe.each([
  ['anthropic-style (partial text)', partialTruncated],
  ['gemini-style (empty text)', emptyTruncated],
])('truncated response in extraction — %s', (_label, makeTruncated) => {
  it('fails the meeting with a readable Hebrew message instead of a JSON SyntaxError', async () => {
    const responses = happyPathResponses();
    responses[6] = makeTruncated();
    const { events, finalMeeting } = await runWithResponses(responses);

    expect(finalMeeting.status).toBe('failed');
    expect(finalMeeting.error).not.toMatch(/Unexpected|JSON/i);
    expect(finalMeeting.error).toContain('נקטעה בשל מגבלת אורך');

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent && 'message' in errorEvent ? errorEvent.message : undefined).toBe(finalMeeting.error);
  });
});
