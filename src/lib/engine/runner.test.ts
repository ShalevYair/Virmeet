import { describe, expect, it } from 'vitest';
import { resolveTaskOwnerName } from './runner';

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
