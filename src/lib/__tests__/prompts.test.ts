import { describe, expect, it } from 'vitest';
import { buildFacilitatorSystemBlocks, buildPersonaSystemBlocks } from '../engine/prompts';
import { OrgSettings, Persona } from '../types';

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
