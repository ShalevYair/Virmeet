import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting, OrgSettings, Persona } from '../types';

// Isolate the ask route from disk I/O (store) and the network (anthropic) —
// spec §6's acceptance criteria (facilitator-or-persona voice, completed-only
// gate, usage roll-up) are about wiring, not storage or model mechanics,
// both of which already have their own test coverage (store.test.ts,
// anthropic.test.ts).
const getMeetingMock = vi.fn();
const updateMeetingMock = vi.fn();
const getOrgSettingsMock = vi.fn();
const listMeetingTypesMock = vi.fn();
const listPersonasMock = vi.fn();
const callModelMock = vi.fn();

vi.mock('@/lib/store', () => ({
  getMeeting: getMeetingMock,
  updateMeeting: updateMeetingMock,
  getOrgSettings: getOrgSettingsMock,
  listMeetingTypes: listMeetingTypesMock,
  listPersonas: listPersonasMock,
}));

vi.mock('@/lib/anthropic', () => ({
  callModel: callModelMock,
}));

const { POST } = await import('../../app/api/meetings/[id]/ask/route');

function makeOrg(): OrgSettings {
  return {
    organizationName: 'org',
    description: 'd',
    constraints: 'c',
    maxMeetingApiCalls: 40,
    maxMeetingTokens: 1_000_000,
    updatedAt: '',
  };
}

function makePersona(): Persona {
  return {
    id: 'p1',
    name: 'אליס',
    role: 'role',
    organization: 'org',
    color: '#000',
    prompt: 'prompt',
    model: 'claude-sonnet-5',
    webAccess: false,
    maxApiCalls: 8,
    maxWebSearches: 0,
    files: [],
    isActive: true,
    createdAt: '',
    updatedAt: '',
  };
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    title: 'test',
    meetingTypeIds: [],
    objective: 'obj',
    participantIds: ['p1'],
    files: [],
    discussionRounds: 2,
    status: 'completed',
    transcript: [],
    result: null,
    error: null,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, apiCalls: 5 },
    createdAt: '',
    updatedAt: '',
    completedAt: '',
    ...overrides,
  };
}

function postRequest(body: unknown, apiKeyHeader?: string): Request {
  return new Request('http://localhost/api/meetings/m1/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKeyHeader ? { 'x-anthropic-api-key': apiKeyHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: 'm1' }) };

describe('POST /api/meetings/[id]/ask', () => {
  beforeEach(() => {
    getMeetingMock.mockReset();
    updateMeetingMock.mockReset();
    getOrgSettingsMock.mockReset();
    listMeetingTypesMock.mockReset();
    listPersonasMock.mockReset();
    callModelMock.mockReset();

    getOrgSettingsMock.mockResolvedValue(makeOrg());
    listMeetingTypesMock.mockResolvedValue([]);
    listPersonasMock.mockResolvedValue([makePersona()]);
    updateMeetingMock.mockResolvedValue(null);
  });

  it('rejects when no API key is configured anywhere', async () => {
    getMeetingMock.mockResolvedValue(makeMeeting());
    const res = await POST(postRequest({ personaId: 'p1', question: 'שאלה?' }), ctx);
    // requireApiKey checks process.env.ANTHROPIC_API_KEY — in the test env it's unset,
    // and we sent no personal key header, so this must fail before ever reaching callModel.
    expect(res.status).toBe(500);
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it('rejects a question on a non-completed meeting', async () => {
    getMeetingMock.mockResolvedValue(makeMeeting({ status: 'draft' }));
    const res = await POST(postRequest({ personaId: 'p1', question: 'שאלה?' }, 'sk-test'), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('הושלמה');
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it('404s when the meeting does not exist', async () => {
    getMeetingMock.mockResolvedValue(null);
    const res = await POST(postRequest({ personaId: 'p1', question: 'שאלה?' }, 'sk-test'), ctx);
    expect(res.status).toBe(404);
  });

  it('answers in the persona voice, persists the follow-up, and rolls usage into the meeting total', async () => {
    getMeetingMock.mockResolvedValue(makeMeeting());
    callModelMock.mockResolvedValue({
      text: 'תשובה מפורטת מנקודת המבט שלי.',
      webSearches: [],
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 5 },
      refused: false,
    });

    const res = await POST(postRequest({ personaId: 'p1', question: 'מה עם התקציב?' }, 'sk-test'), ctx);
    expect(res.status).toBe(200);
    const followUp = await res.json();
    expect(followUp.personaName).toBe('אליס');
    expect(followUp.answer).toBe('תשובה מפורטת מנקודת המבט שלי.');

    // The call used the persona's own model, not the facilitator's.
    expect(callModelMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));

    // Usage was rolled into the meeting's running total (starts at 10/10/0/5).
    expect(updateMeetingMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        usage: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 5, apiCalls: 6 },
        followUps: [expect.objectContaining({ personaId: 'p1', answer: 'תשובה מפורטת מנקודת המבט שלי.' })],
      })
    );
  });

  it('answers as the facilitator when personaId is "facilitator"', async () => {
    getMeetingMock.mockResolvedValue(makeMeeting());
    callModelMock.mockResolvedValue({
      text: 'תשובת המנחה.',
      webSearches: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      refused: false,
    });

    const res = await POST(postRequest({ personaId: 'facilitator', question: 'סיכום?' }, 'sk-test'), ctx);
    expect(res.status).toBe(200);
    const followUp = await res.json();
    expect(followUp.personaName).toBe('מנחה');
    expect(callModelMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5' }));
  });

  it('records a Hebrew refusal line instead of an empty answer', async () => {
    getMeetingMock.mockResolvedValue(makeMeeting());
    callModelMock.mockResolvedValue({
      text: '',
      webSearches: [],
      usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 },
      refused: true,
    });

    const res = await POST(postRequest({ personaId: 'p1', question: 'שאלה?' }, 'sk-test'), ctx);
    const followUp = await res.json();
    expect(followUp.answer).toBe('הפרסונה סירבה לענות על השאלה הזו.');
  });

  it('rejects an unknown personaId with a Hebrew error', async () => {
    getMeetingMock.mockResolvedValue(makeMeeting());
    const res = await POST(postRequest({ personaId: 'does-not-exist', question: 'שאלה?' }, 'sk-test'), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('המשתתף');
    expect(callModelMock).not.toHaveBeenCalled();
  });
});
