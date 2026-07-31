import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from './store';

describe('sanitizeFilename', () => {
  it('leaves a normal filename untouched', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('strips directory components and parent-directory traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('..');
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/');
  });

  it('strips illegal filesystem characters', () => {
    const result = sanitizeFilename('a/b\\c?d%e*f:g|h"i<j>k');
    expect(result).not.toMatch(/[/\\?%*:|"<>]/);
  });

  it('strips control characters', () => {
    const result = sanitizeFilename('bad\x00name\x1f.txt');
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('falls back to "file" for names that sanitize to nothing', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('.')).toBe('file');
    expect(sanitizeFilename('..')).toBe('file');
  });
});
