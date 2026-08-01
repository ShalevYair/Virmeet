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
    await runMeeting(meeting.id, (e) => events.push(e), deps, undefined, controller.signal);

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

  it('forwards the run signal to every model call, so an in-flight request can actually be aborted', async () => {
    const p1 = makePersona({ name: 'א' });
    const p2 = makePersona({ name: 'ב' });
    const meetingType = makeMeetingType();
    const meeting = makeMeeting({
      participantIds: [p1.id, p2.id],
      meetingTypeIds: [meetingType.id],
      discussionRounds: 1,
      status: 'draft',
    });

    const controller = new AbortController();
    const deps = makeDeps({ meeting, personas: [p1, p2], meetingTypes: [meetingType], org: makeOrg() });

    const seenSignals: (AbortSignal | undefined)[] = [];
    const callModel: CallModelFn = async (opts) => {
      seenSignals.push(opts.signal);
      if (opts.jsonSchema) {
        const schema = opts.jsonSchema as { properties: Record<string, unknown> };
        if ('understanding' in schema.properties) {
          return jsonResult({ understanding: 'u', concerns: ['a'], questions: ['a'] });
        }
        return jsonResult({ framing: 'f', conflicts: [] });
      }
      return makeCallModelResult({ text: 'תגובה' });
    };
    deps.callModel = callModel;

    await runMeeting(meeting.id, () => {}, deps, undefined, controller.signal);

    expect(seenSignals.length).toBeGreaterThan(0);
    for (const signal of seenSignals) {
      expect(signal).toBe(controller.signal);
    }
  });

  it('cancelling mid-prep never writes a per-persona error line — the rejections are the cancellation, not a real failure', async () => {
    const p1 = makePersona({ name: 'א' });
    const p2 = makePersona({ name: 'ב' });
    const meetingType = makeMeetingType();
    const meeting = makeMeeting({
      participantIds: [p1.id, p2.id],
      meetingTypeIds: [meetingType.id],
      discussionRounds: 1,
      status: 'draft',
    });

    const controller = new AbortController();
    const deps = makeDeps({ meeting, personas: [p1, p2], meetingTypes: [meetingType], org: makeOrg() });

    // Both prep calls run concurrently (Promise.allSettled); abort as soon as
    // the first one starts, so both reject with an AbortError-shaped
    // rejection exactly like a real aborted fetch would.
    let started = 0;
    const callModel: CallModelFn = async () => {
      started += 1;
      if (started === 1) controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    deps.callModel = callModel;

    const events: MeetingEvent[] = [];
    await runMeeting(meeting.id, (e) => events.push(e), deps, undefined, controller.signal);

    expect(events.filter((e) => e.type === 'cancelled')).toHaveLength(1);
    const finalMeeting = (await deps.getMeeting(meeting.id)) as Meeting;
    expect(finalMeeting.status).toBe('cancelled');
    expect(finalMeeting.transcript.some((e) => e.text.includes('אירעה שגיאה בקבלת תגובה'))).toBe(false);
    expect(finalMeeting.transcript.some((e) => e.text.includes('בוטלה'))).toBe(true);
  });
});
