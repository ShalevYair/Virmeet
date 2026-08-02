import { describe, expect, it } from 'vitest';
import {
  buildAdditionalRoundUserMessage,
  buildGeneralChatUserMessage,
  buildPersonaChatUserMessage,
  buildPersonaSystemBlocks,
} from './prompts';
import { makeMeeting, makeOrg, makePersona } from './__tests__/helpers';
import type { AttachedFile, ChatMessage, MeetingResult, TranscriptEntry } from '../types';
import type { PersonaKnowledgeFile } from './drive-knowledge';

const org = makeOrg();
const persona = makePersona({ files: [] });
const meeting = makeMeeting({ files: [] });

const indexFile: PersonaKnowledgeFile = { name: 'a.pdf', modifiedTime: '2026-01-01T00:00:00.000Z', summary: 'תקציר קצר' };
const deepReadFile: AttachedFile = {
  id: 'file-id',
  name: 'a.pdf',
  mimeType: 'application/octet-stream',
  sizeBytes: 10,
  storedPath: '',
  extractedText: 'התוכן המלא של הקובץ',
  addedAt: '2026-01-01T00:00:00.000Z',
};

describe('buildPersonaSystemBlocks — Drive knowledge blocks', () => {
  it('omits both Drive blocks when no Drive knowledge is passed', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting);
    expect(blocks).toHaveLength(4); // org, sharedFiles, personaPrompt, personaFiles
    expect(blocks.some((b) => b.text.includes('קבצי ידע זמינים ב-Drive'))).toBe(false);
    expect(blocks.some((b) => b.text.includes('קבצים מ-Drive שביקשת לקרוא לעומק'))).toBe(false);
  });

  it('adds the index-summary block (but not the deep-read block) when only an index is available — the prep-call shape', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting, { indexSummary: [indexFile] });
    expect(blocks).toHaveLength(5);
    expect(blocks[4].text).toContain('קבצי ידע זמינים ב-Drive');
    expect(blocks[4].text).toContain('a.pdf: תקציר קצר');
    expect(blocks.some((b) => b.text.includes('קבצים מ-Drive שביקשת לקרוא לעומק'))).toBe(false);
  });

  it('adds both blocks, index summary before deep-read, once deep-read files exist — the post-prep shape', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting, {
      indexSummary: [indexFile],
      deepReadFiles: [deepReadFile],
    });
    expect(blocks).toHaveLength(6);
    expect(blocks[4].text).toContain('קבצי ידע זמינים ב-Drive');
    expect(blocks[5].text).toContain('קבצים מ-Drive שביקשת לקרוא לעומק');
    expect(blocks[5].text).toContain('התוכן המלא של הקובץ');
  });

  it('omits an empty indexSummary array the same as if it were never passed', () => {
    const blocks = buildPersonaSystemBlocks(org, persona, meeting, { indexSummary: [] });
    expect(blocks).toHaveLength(4);
  });

  it('keeps the first four (stable-prefix) blocks byte-identical regardless of Drive knowledge, for cache-hit stability', () => {
    const withoutDrive = buildPersonaSystemBlocks(org, persona, meeting);
    const withDrive = buildPersonaSystemBlocks(org, persona, meeting, {
      indexSummary: [indexFile],
      deepReadFiles: [deepReadFile],
    });
    expect(withDrive.slice(0, 4)).toEqual(withoutDrive);
  });
});

describe('post-meeting chat prompt builders', () => {
  const transcript: TranscriptEntry[] = [
    {
      id: 't1',
      phase: 'discussion',
      speakerId: persona.id,
      speakerName: persona.name,
      round: 1,
      text: 'זו העמדה שהצגתי בפגישה עצמה.',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const result: MeetingResult = {
    summary: 'סיכום הפגישה',
    decisions: ['הוחלט להמשיך בתכנון'],
    openQuestions: [],
    conflicts: [],
    risks: [],
    tasks: [],
    modelAssumptions: [],
  };

  it('buildGeneralChatUserMessage embeds the transcript, result and question, without any persona framing', () => {
    const message = buildGeneralChatUserMessage(meeting, [], transcript, result, [], 'מה סוכם בסוף?');
    expect(message).toContain('זו העמדה שהצגתי בפגישה עצמה.');
    expect(message).toContain('סיכום הפגישה');
    expect(message).toContain('הוחלט להמשיך בתכנון');
    expect(message).toContain('מה סוכם בסוף?');
  });

  it('buildGeneralChatUserMessage degrades gracefully when the meeting never produced a structured result', () => {
    const message = buildGeneralChatUserMessage(meeting, [], transcript, null, [], 'שאלה כלשהי');
    expect(message).toContain('לא הופק סיכום מובנה לפגישה זו');
  });

  it('buildGeneralChatUserMessage includes prior chat turns, most-recent last, capped at 10', () => {
    const priorChat: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      mode: 'general',
      question: `שאלה מספר ${i}`,
      answer: `תשובה מספר ${i}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const message = buildGeneralChatUserMessage(meeting, [], transcript, result, priorChat, 'שאלה חדשה');
    expect(message).not.toContain('שאלה מספר 0\n');
    expect(message).not.toContain('שאלה מספר 1\n');
    expect(message).toContain('שאלה מספר 2\n');
    expect(message).toContain('שאלה מספר 11\n');
  });

  it('buildGeneralChatUserMessage marks a refused prior turn instead of showing an empty answer', () => {
    const priorChat: ChatMessage[] = [
      { id: 'c1', mode: 'general', question: 'שאלה שסורבה', answer: '', refused: true, createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const message = buildGeneralChatUserMessage(meeting, [], transcript, result, priorChat, 'שאלה חדשה');
    expect(message).toContain('סורבה תשובה');
  });

  it('buildPersonaChatUserMessage frames the question as directed at that persona, in their role', () => {
    const message = buildPersonaChatUserMessage(meeting, [], persona, transcript, result, [], 'מה דעתך על זה?');
    expect(message).toContain(persona.role);
    expect(message).toContain('מה דעתך על זה?');
    expect(message).toContain('זו העמדה שהצגתי בפגישה עצמה.');
  });

  it('buildAdditionalRoundUserMessage names the round number and the new topic, matching the live-discussion voice/length rules', () => {
    const message = buildAdditionalRoundUserMessage(meeting, [], persona, 3, transcript, 'האם אפשר לצמצם את התקציב?');
    expect(message).toContain('סבב 3');
    expect(message).toContain('האם אפשר לצמצם את התקציב?');
    expect(message).toContain(persona.role);
    expect(message).toContain('80-200 מילה');
  });
});
