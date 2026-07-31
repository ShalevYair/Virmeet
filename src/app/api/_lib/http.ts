// Virmeet — shared API route helpers (spec §5).
// Every route in src/app/api validates its body with zod and, on failure,
// returns 400 with a Hebrew-only { error } message (never leaking raw
// English zod issue text).

import { NextResponse } from 'next/server';
import { z } from 'zod';

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Hebrew display names for every field validated by schemas in _lib/schemas.ts. */
const FIELD_LABELS_HE: Record<string, string> = {
  // meetings
  title: 'כותרת',
  objective: 'מה רוצים להשיג',
  meetingTypeIds: 'סוג הפגישה',
  participantIds: 'משתתפים',
  discussionRounds: 'מספר סבבי דיון',
  status: 'סטטוס',
  // personas
  name: 'שם',
  role: 'תפקיד',
  organization: 'ארגון',
  color: 'צבע',
  prompt: 'פרומפט',
  model: 'מודל',
  webAccess: 'גישה לרשת',
  maxApiCalls: 'תקציב קריאות',
  maxWebSearches: 'תקציב חיפושי רשת',
  isActive: 'פעיל',
  // meeting types
  shortDescription: 'תיאור קצר',
  // org settings
  organizationName: 'שם הארגון',
  description: 'תיאור',
  constraints: 'אילוצים',
  maxMeetingApiCalls: 'תקרת קריאות מודל לפגישה',
  maxMeetingTokens: 'תקרת טוקנים לפגישה',
  // follow-up questions
  personaId: 'משתתף',
  question: 'שאלה',
};

function fieldLabel(path: (string | number)[]): string {
  if (path.length === 0) return 'קלט';
  const key = String(path[path.length - 1]);
  return FIELD_LABELS_HE[key] ?? path.map(String).join('.');
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
 * 500 with a clear Hebrew message when no Anthropic key is available at all —
 * neither ANTHROPIC_API_KEY on the server nor a client-supplied key (spec §5).
 * `clientKey` is the x-anthropic-api-key header the browser may have sent;
 * pass it through here rather than reading process.env directly so a
 * personal browser key can stand in for a missing server-wide one.
 */
export function requireApiKey(clientKey?: string | null): NextResponse | null {
  if (!clientKey && !process.env.ANTHROPIC_API_KEY) {
    return jsonError(
      'מפתח ה-API של Anthropic לא הוגדר. אפשר להגדיר ANTHROPIC_API_KEY בקובץ .env.local בצד השרת, או להזין מפתח אישי במסך ההגדרות (Settings) בדפדפן.',
      500
    );
  }
  return null;
}
