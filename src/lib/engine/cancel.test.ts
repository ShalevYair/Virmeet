import { describe, expect, it } from 'vitest';
import type { Meeting } from '../types';
import {
  makeCallModelResult,
  makeDeps,
  makeMeeting,
  makeMeetingType,
  makeOrg,
  makePersona,
} from './__tests__/helpers';
import { runMeeting } from './runner';
import type { CallModelFn, MeetingEvent } from './types';

function jsonResult(payload: unknown) {
  return makeCallModelResult({ text: JSON.stringify(payload) });
}

describe('runMeeting cancellation', () => {
  it('stops calling the model at the next checkpoint, marks the meeting cancelled exactly once, and never resurrects status', async () => {
    const p1 = makePersona({ name: 'א' });
    const p2 = makePersona({ name: 'ב' });
    const meetingType = makeMeetingType();
    const meeting = makeMeeting({
      participantIds: [p1.id, p2.id],
      meetingTypeIds: [meetingType.id],
      discussionRounds: 2,
      status: 'draft',
    });

    const controller = new AbortController();
    let callCount = 0;
    let patchCountAtAbort = -1;

    const deps = makeDeps({
      meeting,
      personas: [p1, p2],
      meetingTypes: [meetingType],
      org: makeOrg(),
    });

    const callModel: CallModelFn = async (opts) => {
      callCount += 1;
      if (opts.jsonSchema) {
        const schema = opts.jsonSchema as { properties: Record<string, unknown> };
        if ('understanding' in schema.properties) {
          return jsonResult({ understanding: 'u', concerns: ['a', 'b', 'c'], questions: ['a', 'b', 'c'] });
        }
        return jsonResult({ framing: 'f', conflicts: [] });
      }
      const result = makeCallModelResult({ text: `תור ${callCount}` });
      // The 5th call overall is round 1's second (and last) discussion turn
      // (prep x2, opening x1, discussion round1 p1, discussion round1 p2).
      // Abort right after it resolves — round 2 must never start.
      if (callCount === 5) {
        patchCountAtAbort = deps.patches.length;
        controller.abort();
      }
      return result;
    };
    deps.callModel = callModel;

    const events: MeetingEvent[] = [];
    await runMeeting(meeting.id, (e) => events.push(e), deps, {}, controller.signal);

    expect(callCount).toBe(5);

    const cancelledEvents = events.filter((e) => e.type === 'cancelled');
    expect(cancelledEvents).toHaveLength(1);

    // No patch written *after* the abort fired may resurrect 'running' or
    // 'completed' — patches written before it (e.g. the discussion phase's
    // own emitPhase({status:'running'})) are legitimate history, not a bug.
    for (const patch of deps.patches.slice(patchCountAtAbort)) {
      expect(patch.status).not.toBe('running');
      expect(patch.status).not.toBe('completed');
    }

    const finalMeeting = (await deps.getMeeting(meeting.id)) as Meeting;
    expect(finalMeeting.status).toBe('cancelled');
    expect(finalMeeting.transcript.length).toBeGreaterThan(0);
    expect(finalMeeting.transcript.some((e) => e.text.includes('בוטלה'))).toBe(true);
  });
});
