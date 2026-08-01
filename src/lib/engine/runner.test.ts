import { describe, expect, it } from 'vitest';
import type { Meeting, Persona } from '../types';
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
import { resolveTaskOwnerName, runMeeting } from './runner';
import type { MeetingEvent, RunMeetingDeps } from './types';

describe('resolveTaskOwnerName', () => {
  it('falls back to the project manager when the model reports no clear owner', () => {
    expect(resolveTaskOwnerName('לא שויך')).toBe('מנהל פרויקט');
  });

  it('falls back to the project manager on an empty or blank owner name', () => {
    expect(resolveTaskOwnerName('')).toBe('מנהל פרויקט');
    expect(resolveTaskOwnerName('   ')).toBe('מנהל פרויקט');
  });

  it('keeps a real participant name untouched', () => {
    expect(resolveTaskOwnerName('ארכיטקט תוכנה')).toBe('ארכיטקט תוכנה');
  });
});

// A happy-path call sequence for a 2-participant, 1-round meeting: prep(p1),
// prep(p2), opening, discussion round1(p1), discussion round1(p2),
// convergence, extraction — the creator's turn (when enabled) never calls
// the model, so it isn't in this list.
function validPrep(filesToReadInDepth: string[] = []): CallModelResult {
  return makeCallModelResult({
    text: JSON.stringify({ understanding: 'u', concerns: ['a', 'b', 'c'], questions: ['a', 'b', 'c'], filesToReadInDepth }),
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
function validExtraction(title = 't'): CallModelResult {
  return makeCallModelResult({
    text: JSON.stringify({
      title,
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
function happyPathResponses(
  extractedTitle?: string,
  prepResponses: [CallModelResult, CallModelResult] = [validPrep(), validPrep()]
): CallModelResult[] {
  return [
    prepResponses[0],
    prepResponses[1],
    validOpening(),
    validDiscussion('1'),
    validDiscussion('2'),
    validConvergence(),
    validExtraction(extractedTitle),
  ];
}

async function runHappyPath(
  meetingOverrides: Partial<Meeting> = {},
  depsOverrides: {
    requestCreatorTurn?: RunMeetingDeps['requestCreatorTurn'];
    refreshDriveKnowledge?: RunMeetingDeps['refreshDriveKnowledge'];
    fetchDriveDeepReadFile?: RunMeetingDeps['fetchDriveDeepReadFile'];
    personaOverrides?: [Partial<Persona>?, Partial<Persona>?];
    prepResponses?: [CallModelResult, CallModelResult];
  } = {},
  extractedTitle?: string
) {
  const p1 = makePersona({ name: 'א', ...depsOverrides.personaOverrides?.[0] });
  const p2 = makePersona({ name: 'ב', ...depsOverrides.personaOverrides?.[1] });
  const meetingType = makeMeetingType();
  const meeting = makeMeeting({
    title: '',
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
    callModel: scriptedCallModel(happyPathResponses(extractedTitle, depsOverrides.prepResponses)),
    requestCreatorTurn: depsOverrides.requestCreatorTurn,
    refreshDriveKnowledge: depsOverrides.refreshDriveKnowledge,
    fetchDriveDeepReadFile: depsOverrides.fetchDriveDeepReadFile,
  });

  const events: MeetingEvent[] = [];
  await runMeeting(meeting.id, (e) => events.push(e), deps, undefined);
  const finalMeeting = (await deps.getMeeting(meeting.id)) as Meeting;
  return finalMeeting;
}

describe('meeting title — generated at extraction', () => {
  it('persists the title the model returned in the extraction step', async () => {
    const finalMeeting = await runHappyPath({}, {}, 'כותרת שנוצרה');
    expect(finalMeeting.title).toBe('כותרת שנוצרה');
  });

  it('falls back to whatever title the meeting already had if the model returns a blank one', async () => {
    const finalMeeting = await runHappyPath({ title: 'כותרת ידנית קודמת' }, {}, '   ');
    expect(finalMeeting.title).toBe('כותרת ידנית קודמת');
  });
});

describe('creator participation in discussion rounds', () => {
  it('asks for the creator\'s turn once per round, after the personas, and adds it to the transcript', async () => {
    const calls: { round: number; totalRounds: number }[] = [];
    const finalMeeting = await runHappyPath(
      { creatorParticipates: true },
      {
        requestCreatorTurn: async (info) => {
          calls.push(info);
          return 'התוספת שלי לדיון';
        },
      }
    );

    expect(calls).toEqual([{ round: 1, totalRounds: 1 }]);

    const creatorEntry = finalMeeting.transcript.find((e) => e.speakerId === 'creator');
    expect(creatorEntry?.text).toBe('התוספת שלי לדיון');
    expect(creatorEntry?.round).toBe(1);

    // Ordering: the creator's line comes after both personas' round-1 lines.
    const discussionSpeakers = finalMeeting.transcript.filter((e) => e.phase === 'discussion').map((e) => e.speakerId);
    expect(discussionSpeakers.at(-1)).toBe('creator');
  });

  it('never asks for a turn when the meeting creator is not a participant', async () => {
    let called = false;
    const finalMeeting = await runHappyPath(
      { creatorParticipates: false },
      {
        requestCreatorTurn: async () => {
          called = true;
          return 'לא אמור לקרות';
        },
      }
    );

    expect(called).toBe(false);
    expect(finalMeeting.transcript.some((e) => e.speakerId === 'creator')).toBe(false);
  });

  it('adds no transcript entry when the creator skips a round (blank/whitespace response)', async () => {
    const finalMeeting = await runHappyPath(
      { creatorParticipates: true },
      { requestCreatorTurn: async () => '   ' }
    );

    expect(finalMeeting.transcript.some((e) => e.speakerId === 'creator')).toBe(false);
  });

  it('does nothing when creatorParticipates is true but no requestCreatorTurn dep was supplied', async () => {
    const finalMeeting = await runHappyPath({ creatorParticipates: true });
    expect(finalMeeting.status).toBe('completed');
    expect(finalMeeting.transcript.some((e) => e.speakerId === 'creator')).toBe(false);
  });
});

describe('Drive knowledge refresh before prep', () => {
  it('refreshes the index for every participant with a driveFolderId, before any prep call, and logs a system line', async () => {
    const calls: string[] = [];
    const finalMeeting = await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }, { driveFolderId: 'folder-b' }],
        refreshDriveKnowledge: async (folderId) => {
          calls.push(folderId);
          return { files: [], fileIdsByName: {}, changedCount: 2, totalCount: 3, truncated: false };
        },
      }
    );

    expect(calls).toEqual(['folder-a', 'folder-b']);
    const driveLines = finalMeeting.transcript.filter((e) => e.text.includes('אינדקס הידע'));
    expect(driveLines).toHaveLength(2);
    expect(driveLines[0].text).toContain('2 קבצים חדשים/עודכנו מתוך 3');
    expect(driveLines[0].phase).toBe('prep');
    // Both Drive refresh lines land before the first real prep transcript entry.
    const firstPrepIndex = finalMeeting.transcript.findIndex((e) => e.speakerId === finalMeeting.participantIds[0]);
    expect(finalMeeting.transcript.indexOf(driveLines[1])).toBeLessThan(firstPrepIndex);
  });

  it('never calls refreshDriveKnowledge for a participant without a driveFolderId', async () => {
    let called = false;
    await runHappyPath(
      {},
      {
        refreshDriveKnowledge: async () => {
          called = true;
          return { files: [], fileIdsByName: {}, changedCount: 0, totalCount: 0, truncated: false };
        },
      }
    );
    expect(called).toBe(false);
  });

  it('logs a failure line and keeps going when refreshDriveKnowledge rejects, instead of failing the meeting', async () => {
    const finalMeeting = await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }],
        refreshDriveKnowledge: async () => {
          throw new Error('אין חיבור פעיל ל-Drive');
        },
      }
    );

    expect(finalMeeting.status).toBe('completed');
    const failureLine = finalMeeting.transcript.find((e) => e.text.includes('רענון אינדקס הידע'));
    expect(failureLine?.text).toContain('אין חיבור פעיל ל-Drive');
  });
});

describe('Drive deep-read after prep', () => {
  function refreshWith(fileIdsByName: Record<string, string>): RunMeetingDeps['refreshDriveKnowledge'] {
    return async () => ({ files: [], fileIdsByName, changedCount: 0, totalCount: 0, truncated: false });
  }

  it("fetches the files a persona named in filesToReadInDepth, resolved via that persona's own Drive index", async () => {
    const fetchCalls: { fileId: string; fileName: string }[] = [];
    const finalMeeting = await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }],
        prepResponses: [validPrep(['a.pdf']), validPrep()],
        refreshDriveKnowledge: refreshWith({ 'a.pdf': 'file-id-a' }),
        fetchDriveDeepReadFile: async (fileId, fileName) => {
          fetchCalls.push({ fileId, fileName });
          return {
            id: fileId,
            name: fileName,
            mimeType: 'application/octet-stream',
            sizeBytes: 10,
            storedPath: '',
            extractedText: 'תוכן מלא',
            addedAt: new Date().toISOString(),
          };
        },
      }
    );

    expect(fetchCalls).toEqual([{ fileId: 'file-id-a', fileName: 'a.pdf' }]);
    const line = finalMeeting.transcript.find((e) => e.text.includes('קרא/ה לעומק מ-Drive'));
    expect(line?.text).toContain('a.pdf');
  });

  it('skips a requested file name silently when it is not in that run\'s Drive index (hallucinated/stale)', async () => {
    let called = false;
    const finalMeeting = await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }],
        prepResponses: [validPrep(['does-not-exist.pdf']), validPrep()],
        refreshDriveKnowledge: refreshWith({ 'a.pdf': 'file-id-a' }),
        fetchDriveDeepReadFile: async () => {
          called = true;
          throw new Error('should not be called');
        },
      }
    );

    expect(called).toBe(false);
    expect(finalMeeting.transcript.some((e) => e.text.includes('קרא/ה לעומק'))).toBe(false);
  });

  it('logs a per-file failure line and keeps going when a deep-read fetch rejects', async () => {
    const finalMeeting = await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }],
        prepResponses: [validPrep(['a.pdf']), validPrep()],
        refreshDriveKnowledge: refreshWith({ 'a.pdf': 'file-id-a' }),
        fetchDriveDeepReadFile: async () => {
          throw new Error('ההורדה נכשלה');
        },
      }
    );

    expect(finalMeeting.status).toBe('completed');
    const failureLine = finalMeeting.transcript.find((e) => e.text.includes('קריאה לעומק'));
    expect(failureLine?.text).toContain('ההורדה נכשלה');
  });

  it('caps deep-read requests at MAX_DEEP_READ_FILES_PER_PERSONA', async () => {
    const fetchCalls: string[] = [];
    await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }],
        prepResponses: [validPrep(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']), validPrep()],
        refreshDriveKnowledge: refreshWith({
          'a.pdf': 'id-a',
          'b.pdf': 'id-b',
          'c.pdf': 'id-c',
          'd.pdf': 'id-d',
        }),
        fetchDriveDeepReadFile: async (fileId, fileName) => {
          fetchCalls.push(fileName);
          return {
            id: fileId,
            name: fileName,
            mimeType: 'application/octet-stream',
            sizeBytes: 1,
            storedPath: '',
            extractedText: '',
            addedAt: new Date().toISOString(),
          };
        },
      }
    );

    expect(fetchCalls).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('never calls fetchDriveDeepReadFile when a persona requests nothing', async () => {
    let called = false;
    await runHappyPath(
      {},
      {
        personaOverrides: [{ driveFolderId: 'folder-a' }],
        refreshDriveKnowledge: refreshWith({ 'a.pdf': 'file-id-a' }),
        fetchDriveDeepReadFile: async () => {
          called = true;
          throw new Error('should not be called');
        },
      }
    );
    expect(called).toBe(false);
  });
});
