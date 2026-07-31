import { describe, expect, it } from 'vitest';
import {
  buildDiscussionContextBlock,
  buildDiscussionInstructionBlock,
  buildFacilitatorSystemBlocks,
  buildPersonaSystemBlocks,
  roundSkippedLine,
} from '../engine/prompts';
import { Meeting, MeetingType, OrgSettings, Persona, TranscriptEntry } from '../types';

function makeOrg(): OrgSettings {
  return {
    organizationName: 'ארגון בדיקה',
    description: 'תיאור',
    constraints: 'אילוצים',
    maxMeetingApiCalls: 40,
    maxMeetingTokens: 1_000_000,
    updatedAt: '',
  };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    name: 'ארכיטקט',
    role: 'ארכיטקט תשתיות',
    organization: 'אגף טכנולוגיות',
    color: '#000000',
    prompt: 'זהו הפרומפט האישי של הפרסונה.',
    model: 'claude-sonnet-5',
    webAccess: false,
    maxApiCalls: 8,
    maxWebSearches: 0,
    files: [],
    isActive: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('buildPersonaSystemBlocks (spec §3.2 — cache stability)', () => {
  it('returns exactly 3 blocks, in the fixed [org, persona, files] order', () => {
    const blocks = buildPersonaSystemBlocks(makeOrg(), makePersona());
    expect(blocks).toHaveLength(3);
    expect(blocks[1].text).toBe('זהו הפרומפט האישי של הפרסונה.');
    expect(blocks.every((b) => b.type === 'text')).toBe(true);
  });

  it('keeps the block count and order identical regardless of persona files', () => {
    const withFiles = buildPersonaSystemBlocks(
      makeOrg(),
      makePersona({
        files: [
          {
            id: 'f1',
            name: 'a.txt',
            mimeType: 'text/plain',
            sizeBytes: 10,
            storedPath: 'uploads/p1/f1__a.txt',
            extractedText: 'תוכן',
            addedAt: '',
          },
        ],
      })
    );
    expect(withFiles).toHaveLength(3);
    expect(withFiles[1].text).toBe('זהו הפרומפט האישי של הפרסונה.');
  });

  it('includes the "I don\'t have the information" permission (spec §3.3)', () => {
    const blocks = buildPersonaSystemBlocks(makeOrg(), makePersona());
    const orgBlockText = blocks[0].text;
    expect(orgBlockText).toContain('אין לך את המידע הדרוש');
    expect(orgBlockText).toContain('זו תשובה מוצלחת ולגיטימית');
  });
});

describe('buildFacilitatorSystemBlocks', () => {
  it('returns exactly 2 stable blocks', () => {
    const blocks = buildFacilitatorSystemBlocks(makeOrg());
    expect(blocks).toHaveLength(2);
  });
});

describe('buildDiscussionContextBlock (spec P4.3 — cache-friendly prefix growth)', () => {
  it("round N's context block is a byte-for-byte prefix of round N+1's, once entries are only appended", () => {
    const meeting: Meeting = {
      id: 'm1',
      title: 'כותרת',
      meetingTypeIds: ['t1'],
      objective: 'מטרה',
      participantIds: ['p1'],
      files: [],
      discussionRounds: 2,
      status: 'running',
      transcript: [],
      result: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
      createdAt: '',
      updatedAt: '',
      completedAt: null,
    };
    const meetingTypes: MeetingType[] = [
      { id: 't1', title: 'סוג', shortDescription: 'x', prompt: 'y', isBuiltIn: true, createdAt: '', updatedAt: '' },
    ];
    const opening = { framing: 'מסגור', conflicts: [] };

    const entry = (i: number): TranscriptEntry => ({
      id: `e${i}`,
      phase: 'discussion',
      speakerId: `p${i}`,
      speakerName: `דובר ${i}`,
      round: 1,
      text: `דברי דובר מספר ${i}`,
      createdAt: '',
    });

    const roundOne = buildDiscussionContextBlock(meeting, meetingTypes, opening, [entry(1)]);
    const roundTwo = buildDiscussionContextBlock(meeting, meetingTypes, opening, [entry(1), entry(2)]);

    expect(roundTwo.startsWith(roundOne)).toBe(true);
    expect(roundTwo.length).toBeGreaterThan(roundOne.length);
  });

  it('never embeds the round number — that lives in the separate, un-cached instruction block', () => {
    const meeting: Meeting = {
      id: 'm1',
      title: 'כותרת',
      meetingTypeIds: ['t1'],
      objective: 'מטרה',
      participantIds: ['p1'],
      files: [],
      discussionRounds: 2,
      status: 'running',
      transcript: [],
      result: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
      createdAt: '',
      updatedAt: '',
      completedAt: null,
    };
    const meetingTypes: MeetingType[] = [
      { id: 't1', title: 'סוג', shortDescription: 'x', prompt: 'y', isBuiltIn: true, createdAt: '', updatedAt: '' },
    ];
    const block = buildDiscussionContextBlock(meeting, meetingTypes, { framing: 'f', conflicts: [] }, []);
    expect(block).not.toMatch(/סבב \d+ מתוך \d+/);
  });
});

describe('buildDiscussionInstructionBlock (P8 — focused question is opt-in)', () => {
  it('uses the generic "your turn to speak" opening when no focus question is given (round-robin, unchanged)', () => {
    const persona = makePersona();
    const block = buildDiscussionInstructionBlock(persona, 1, 2);
    expect(block).toContain('זהו תורך לדבר');
    expect(block).not.toContain('המנחה מבקש ממך');
  });

  it('replaces the opening with the facilitator\'s focused question when one is given (facilitated mode)', () => {
    const persona = makePersona();
    const block = buildDiscussionInstructionBlock(persona, 1, 2, 'האם התשתית תעמוד בעומס הזה?');
    expect(block).toContain('המנחה מבקש ממך');
    expect(block).toContain('האם התשתית תעמוד בעומס הזה?');
  });
});

describe('roundSkippedLine (P8)', () => {
  it('names the skipped persona and the round in Hebrew', () => {
    const line = roundSkippedLine('בוב', 3);
    expect(line).toContain('בוב');
    expect(line).toContain('לא נבחר/ה');
    expect(line).toContain('סבב 3');
  });
});
