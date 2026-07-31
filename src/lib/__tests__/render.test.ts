import { describe, expect, it } from 'vitest';
import { DISCLAIMER_HE, renderMarkdown } from '../../app/api/meetings/[id]/export/render';
import { Meeting } from '../types';

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    title: 'פגישת בדיקה',
    meetingTypeIds: [],
    objective: 'מטרה',
    participantIds: [],
    files: [],
    discussionRounds: 2,
    status: 'draft',
    transcript: [],
    result: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
    createdAt: '',
    updatedAt: '',
    completedAt: null,
    ...overrides,
  };
}

describe('renderMarkdown (spec §3.5 — disclosure banner)', () => {
  it('opens with the disclaimer verbatim, word for word', () => {
    const md = renderMarkdown(makeMeeting());
    const firstLine = md.split('\n')[0];
    expect(firstLine).toBe(`> **${DISCLAIMER_HE}**`);
  });

  it('fails if the disclaimer text is ever weakened or removed', () => {
    // Locks the exact wording in place — any edit to DISCLAIMER_HE must be intentional.
    expect(DISCLAIMER_HE).toBe(
      'הפלט הזה הוא הכנה לפגישה, לא תחליף לה. הדעות כאן נוצרו על ידי מודל שפה ואינן מייצגות את עמדתם של אנשים אמיתיים.'
    );
  });

  it('always includes a consumption ("צריכה") section', () => {
    const md = renderMarkdown(
      makeMeeting({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, apiCalls: 3 } })
    );
    expect(md).toContain('## צריכה');
    expect(md).toContain('מספר קריאות מודל: 3');
  });
});
