import { describe, expect, it } from 'vitest';
import { validateId } from './http';

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
