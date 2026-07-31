import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJsonBody, validateId } from './http';
import { meetingCreateSchema } from './schemas';

describe('validateId', () => {
  it('accepts a well-formed UUID', () => {
    expect(validateId('123e4567-e89b-12d3-a456-426614174000')).toBeNull();
  });

  it('rejects a non-UUID id with a Hebrew 400, before touching anything else', async () => {
    const res = validateId('../../etc/passwd');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(400);
    const body = await res?.json();
    expect(body.error).toBe('מזהה לא תקין.');
  });

  it('rejects an empty id', () => {
    expect(validateId('')).not.toBeNull();
  });
});

function fakeRequest(body: unknown): Request {
  return new Request('http://localhost/api/meetings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('parseJsonBody field labels (B3: no English field names leak to the user)', () => {
  it('reports a validation error using the Hebrew field label, not the raw zod path', async () => {
    const parsed = await parseJsonBody(
      fakeRequest({
        title: 'כותרת',
        meetingTypeIds: ['x'],
        objective: '', // too_small — missing objective
        participantIds: ['a', 'b'],
      }),
      meetingCreateSchema
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const body = await parsed.response.json();
      expect(body.error).toContain('מטרת הפגישה');
      expect(body.error).not.toContain('objective');
    }
  });

  it('falls back to a generic Hebrew label for a field with no translation entry', async () => {
    const schema = z.object({ someUntranslatedField: z.string().min(1) });
    const parsed = await parseJsonBody(fakeRequest({ someUntranslatedField: '' }), schema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const body = await parsed.response.json();
      expect(body.error).toContain('הקלט');
      expect(body.error).not.toContain('someUntranslatedField');
    }
  });
});
