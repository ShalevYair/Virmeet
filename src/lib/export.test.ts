import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './export';
import { makeMeeting, makePersona } from './engine/__tests__/helpers';
import type { ChatMessage } from './types';

describe('renderMarkdown — post-meeting chat section', () => {
  it('omits the chat section entirely when the meeting has no chat', () => {
    const meeting = makeMeeting({ status: 'completed', chat: [] });
    expect(renderMarkdown(meeting)).not.toContain("צ'אט אחרי הפגישה");
  });

  it('renders a general question as answered by "מנחה", not any persona', () => {
    const chat: ChatMessage[] = [
      { id: 'c1', mode: 'general', question: 'מה סוכם?', answer: 'סוכם להמשיך', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const meeting = makeMeeting({ status: 'completed', chat });
    const md = renderMarkdown(meeting);
    expect(md).toContain("צ'אט אחרי הפגישה");
    expect(md).toContain('**שאלה (מנחה):** מה סוכם?');
    expect(md).toContain('סוכם להמשיך');
  });

  it("resolves a persona-directed question to that persona's name when given the participant list", () => {
    const persona = makePersona({ name: 'עידית', role: 'ארכיטקטית' });
    const chat: ChatMessage[] = [
      {
        id: 'c1',
        mode: 'persona',
        personaId: persona.id,
        question: 'מה דעתך?',
        answer: 'תשובתי',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const meeting = makeMeeting({ status: 'completed', chat });
    const md = renderMarkdown(meeting, [persona]);
    expect(md).toContain('**שאלה (עידית):** מה דעתך?');
  });

  it('falls back to a generic label when the persona behind a chat turn is unknown (e.g. deleted since)', () => {
    const chat: ChatMessage[] = [
      {
        id: 'c1',
        mode: 'persona',
        personaId: 'missing-persona',
        question: 'שאלה',
        answer: 'תשובה',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const meeting = makeMeeting({ status: 'completed', chat });
    const md = renderMarkdown(meeting, []);
    expect(md).toContain('**שאלה (משתתף):** שאלה');
  });

  it('marks a refused turn instead of showing an empty answer', () => {
    const chat: ChatMessage[] = [
      { id: 'c1', mode: 'general', question: 'שאלה', answer: '', refused: true, createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const meeting = makeMeeting({ status: 'completed', chat });
    expect(renderMarkdown(meeting)).toContain('סורבה תשובה');
  });
});
