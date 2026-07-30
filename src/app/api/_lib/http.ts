// Virmeet — shared API route helpers (spec §5).
// Every route in src/app/api validates its body with zod and, on failure,
// returns 400 with a Hebrew-only { error } message (never leaking raw
// English zod issue text).

import { NextResponse } from 'next/server';
import { z } from 'zod';

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function fieldLabel(path: (string | number)[]): string {
  return path.length ? path.map(String).join('.') : 'קלט';
}

/** Renders a single zod issue as a Hebrew-only sentence — never echoes the English default message. */
function issueToHebrew(issue: z.ZodIssue): string {
  const field = fieldLabel(issue.path);
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return `השדה "${field}" חסר או מסוג לא תקין.`;
    case z.ZodIssueCode.too_small:
      return `השדה "${field}" קטן מדי, קצר מדי, או ריק.`;
    case z.ZodIssueCode.too_big:
      return `השדה "${field}" גדול מדי או ארוך מדי.`;
    case z.ZodIssueCode.invalid_enum_value:
      return `השדה "${field}" מכיל ערך לא נתמך.`;
    case z.ZodIssueCode.unrecognized_keys:
      return `הבקשה מכילה שדות לא מוכרים.`;
    case z.ZodIssueCode.custom:
      return issue.message || `השדה "${field}" אינו תקין.`;
    default:
      return `השדה "${field}" אינו תקין.`;
  }
}

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** Parses the request body as JSON and validates it against `schema`. Never throws. */
export async function parseJsonBody<T>(req: Request, schema: z.ZodSchema<T>): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: jsonError('גוף הבקשה אינו JSON תקין.', 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: jsonError(issueToHebrew(result.error.issues[0]), 400) };
  }
  return { ok: true, data: result.data };
}

/** Standard 500 for any unexpected error thrown by a route handler's try/catch. */
export function internalError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : 'שגיאה לא צפויה בשרת.';
  return jsonError(message, 500);
}

/**
 * 500 with a clear Hebrew message when NEITHER provider has a key available
 * at all — not ANTHROPIC_API_KEY/GEMINI_API_KEY on the server, and not a
 * client-supplied key for either. A meeting only actually needs the key for
 * whichever provider its personas' models use, but that can't be known until
 * the meeting's personas are loaded — so this is a coarse pre-check, and a
 * persona/facilitator call missing its own provider's key still fails
 * gracefully per-call inside runMeeting (see runner.ts).
 * `clientKeys` are the x-anthropic-api-key / x-gemini-api-key headers the
 * browser may have sent; passed through here rather than reading
 * process.env directly so a personal browser key can stand in for a missing
 * server-wide one.
 */
export function requireApiKey(
  anthropicClientKey?: string | null,
  geminiClientKey?: string | null
): NextResponse | null {
  const hasAnthropic = Boolean(anthropicClientKey) || Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(geminiClientKey) || Boolean(process.env.GEMINI_API_KEY);
  if (!hasAnthropic && !hasGemini) {
    return jsonError(
      'לא הוגדר אף מפתח API — לא Anthropic ולא Gemini. אפשר להגדיר ANTHROPIC_API_KEY / GEMINI_API_KEY בקובץ .env.local בצד השרת, או להזין מפתח אישי במסך ההגדרות (Settings) בדפדפן.',
      500
    );
  }
  return null;
}
