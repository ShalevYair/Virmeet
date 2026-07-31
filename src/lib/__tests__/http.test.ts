import { describe, expect, it } from 'vitest';
import { parseJsonBody } from '../../app/api/_lib/http';
import {
  meetingCreateSchema,
  meetingUpdateSchema,
  orgUpdateSchema,
  personaCreateSchema,
} from '../../app/api/_lib/schemas';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// English identifiers that must never leak into a Hebrew error sentence.
const ENGLISH_FIELD_KEYS = [
  'objective',
  'participantIds',
  'meetingTypeIds',
  'discussionRounds',
  'maxApiCalls',
  'maxWebSearches',
  'webAccess',
  'isActive',
  'organizationName',
  'title',
];

async function getErrorMessage(res: Response): Promise<string> {
  const body = (await res.json()) as { error: string };
  return body.error;
}

describe('parseJsonBody — Hebrew-only error messages', () => {
  it('rejects malformed JSON with a Hebrew message', async () => {
    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{not json',
    });
    const parsed = await parseJsonBody(req, meetingCreateSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.status).toBe(400);
      const message = await getErrorMessage(parsed.response);
      expect(message).toBe('גוף הבקשה אינו JSON תקין.');
    }
  });

  it('translates a missing required field (objective) to a Hebrew field name', async () => {
    const req = jsonRequest({
      title: 'כותרת',
      meetingTypeIds: ['t1'],
      participantIds: ['p1', 'p2'],
      // objective missing
    });
    const parsed = await parseJsonBody(req, meetingCreateSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const message = await getErrorMessage(parsed.response);
      expect(message).toContain('מה רוצים להשיג');
      for (const key of ENGLISH_FIELD_KEYS) {
        expect(message).not.toContain(key);
      }
    }
  });

  it('translates a too-few-participants error without leaking the raw key', async () => {
    const req = jsonRequest({
      title: 'כותרת',
      objective: 'מטרה',
      meetingTypeIds: ['t1'],
      participantIds: ['p1'], // needs >= 2
    });
    const parsed = await parseJsonBody(req, meetingCreateSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const message = await getErrorMessage(parsed.response);
      expect(message).toContain('משתתפים');
      for (const key of ENGLISH_FIELD_KEYS) {
        expect(message).not.toContain(key);
      }
    }
  });

  it('translates an invalid meeting status value', async () => {
    const req = jsonRequest({ status: 'not-a-real-status' });
    const parsed = await parseJsonBody(req, meetingUpdateSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const message = await getErrorMessage(parsed.response);
      expect(message).toContain('סטטוס');
      expect(message).not.toContain('status');
    }
  });

  it('translates org settings field names (maxMeetingApiCalls / maxMeetingTokens)', async () => {
    const req = jsonRequest({ maxMeetingApiCalls: 0 });
    const parsed = await parseJsonBody(req, orgUpdateSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const message = await getErrorMessage(parsed.response);
      expect(message).toContain('תקרת קריאות מודל לפגישה');
      expect(message).not.toContain('maxMeetingApiCalls');
    }
  });

  it('translates persona field names (maxApiCalls)', async () => {
    const req = jsonRequest({
      name: 'שם',
      role: 'תפקיד',
      organization: 'ארגון',
      color: '#000',
      prompt: 'פרומפט',
      model: 'claude-sonnet-5',
      webAccess: false,
      maxApiCalls: 999, // over the max
      maxWebSearches: 0,
    });
    const parsed = await parseJsonBody(req, personaCreateSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const message = await getErrorMessage(parsed.response);
      expect(message).toContain('תקציב קריאות');
      expect(message).not.toContain('maxApiCalls');
    }
  });
});
