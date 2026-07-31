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

function validPrep(): CallModelResult {
  return makeCallModelResult({
    text: JSON.stringify({ understanding: 'u', concerns: ['a', 'b', 'c'], questions: ['a', 'b', 'c'] }),
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 500 },
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

function happyPathResponses(): CallModelResult[] {
  return [validPrep(), validPrep(), validOpening(), validDiscussion('1'), validDiscussion('2'), validConvergence(), validExtraction()];
}

async function runHappyPath(meetingOverrides: Partial<Meeting> = {}) {
  const p1 = makePersona({ name: 'א' });
  const p2 = makePersona({ name: 'ב' });
  const meetingType = makeMeetingType();
  const meeting = makeMeeting({
    participantIds: [p1.id, p2.id],
    meetingTypeIds: [meetingType.id],
    discussionRounds: 1,
    status: 'draft',
    ...meetingOverrides,
  });
  const deps = makeDeps({
    meeting,
    personas: [p1, p2],
    meetingTypes: [meetingType],
    org: makeOrg(),
    callModel: scriptedCallModel(happyPathResponses()),
  });

  const events: MeetingEvent[] = [];
  await runMeeting(meeting.id, (e) => events.push(e), deps, {});
  const finalMeeting = (await deps.getMeeting(meeting.id)) as Meeting;
  return finalMeeting;
}

describe('usage — cacheWriteTokens', () => {
  it('sums cache-creation tokens from every call into the final usage total', async () => {
    const finalMeeting = await runHappyPath();
    // Only the two prep calls report cacheWriteTokens (500 each); every
    // other scripted response defaults to 0 via makeCallModelResult.
    expect(finalMeeting.usage.cacheWriteTokens).toBe(1000);
  });

  it('defaults a pre-existing usage record with no cacheWriteTokens field to 0 instead of NaN', async () => {
    // Simulates a meeting written to IndexedDB before this field existed —
    // the stored object genuinely has no cacheWriteTokens key at runtime,
    // even though the static Meeting type now requires one.
    const staleUsage = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, apiCalls: 1 } as Meeting['usage'];
    const finalMeeting = await runHappyPath({ usage: staleUsage });

    expect(finalMeeting.usage.cacheWriteTokens).toBe(1000);
    expect(Number.isNaN(finalMeeting.usage.cacheWriteTokens)).toBe(false);
    expect(Number.isNaN(finalMeeting.usage.inputTokens)).toBe(false);
  });
});
