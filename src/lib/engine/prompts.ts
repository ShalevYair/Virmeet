// Virmeet — Hebrew prompt builders for the meeting engine (spec §4).
//
// Caching note: for every persona, `system` is always built as exactly
// [orgBlock, personaPrompt, personaFilesBlock] and none of those three change
// during a meeting run — only the `messages` (user turn) content changes
// between prep/opening/discussion calls. That stability is what lets
// prompt caching (cache_control on the last system block) actually hit across
// a persona's repeated calls in the same meeting. Do not fold per-phase or
// per-round content into the system blocks.

import { FollowUp, Meeting, MeetingType, OrgSettings, Persona, TranscriptEntry } from '../types';
import { SystemBlock } from '../anthropic';
import { OpeningOutput, PrepOutput } from './types';

const PHASE_LABELS_HE: Record<TranscriptEntry['phase'], string> = {
  prep: 'הכנה',
  opening: 'פתיחה',
  discussion: 'דיון',
  convergence: 'התכנסות',
  extraction: 'חילוץ משימות',
};

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Org context + generic simulation instructions, shared verbatim by every persona and the facilitator. */
function buildOrgBlock(org: OrgSettings): string {
  return `# הקשר ארגוני

ארגון: ${org.organizationName}

${org.description}

## אילוצים
${org.constraints}

# איך לנהוג בסימולציה הזו

אתה משתתף בסימולציה של פגישה. חשוב מאוד:

- אתה עונה אך ורק מנקודת המבט של התפקיד שלך, כפי שמתואר בפרומפט האישי שלך. אל תנסה
  "לפתור הכול" או להסכים עם כולם כדי ליצור הרמוניה — לתפקיד שלך יש אינטרסים
  ואילוצים אמיתיים, ולעיתים הם מתנגשים עם תפקידים אחרים. זה בסדר גמור, וזו בדיוק
  הסיבה שיש כמה משתתפים בפגישה.
- אם אין לך את המידע הדרוש כדי לענות על שאלה — **זו תשובה מוצלחת ולגיטימית** לומר
  זאת במפורש, למשל: "אין לי את המידע הזה, צריך לבדוק מול [גורם/תפקיד רלוונטי]".
  אל תמציא מספרים, תאריכים או עובדות רק כדי להישמע בטוח. הודאה בפער ידע עם הפניה
  למי שכן אמור לדעת שווה הרבה יותר מניחוש שנשמע משכנע.
- דבר בעברית תקנית, בגובה העיניים של אדם אמיתי בתפקיד הזה — לא כמו עוזר וירטואלי.
- אורך התשובה חייב לעמוד בהנחיה שתינתן לך בכל שלב.`;
}

/** Renders a persona's private background files as prompt text (may be empty). */
function buildFilesBlock(files: Persona['files'] | Meeting['files']): string {
  if (files.length === 0) {
    return '# קבצי רקע\n\nאין קבצי רקע מצורפים.';
  }
  const parts = files.map((f) => {
    const body = f.extractionError
      ? `[לא ניתן היה לחלץ טקסט מהקובץ הזה: ${f.extractionError}]`
      : f.extractedText || '[הקובץ ריק]';
    return `### ${f.name}\n${body}`;
  });
  return `# קבצי רקע\n\n${parts.join('\n\n')}`;
}

/** [orgBlock, personaPrompt, personaFilesBlock] — stable for the whole meeting, cache_control on the last block. */
export function buildPersonaSystemBlocks(org: OrgSettings, persona: Persona): SystemBlock[] {
  return [
    { type: 'text', text: buildOrgBlock(org) },
    { type: 'text', text: persona.prompt },
    { type: 'text', text: buildFilesBlock(persona.files) },
  ];
}

const FACILITATOR_ROLE_PROMPT = `אתה המנחה (facilitator) של הפגישה. אתה לא צד בדיון ואין לך אינטרס אישי בתוצאה —
תפקידך הוא לארגן, למסגר, לזהות מחלוקות במפורש, ולסכם באופן נאמן למה שנאמר בפועל.
אל תמציא הסכמה שלא הייתה, ואל תטשטש מחלוקת אמיתית כדי שהפלט ייראה "נקי" יותר.
כשמידע חסר או לא נאמר במפורש בדיון, סמן זאת ככזה — אל תשלים אותו כעובדה.`;

/** [orgBlock, facilitatorRolePrompt] — stable across opening/convergence/extraction for cache hits. */
export function buildFacilitatorSystemBlocks(org: OrgSettings): SystemBlock[] {
  return [
    { type: 'text', text: buildOrgBlock(org) },
    { type: 'text', text: FACILITATOR_ROLE_PROMPT },
  ];
}

function meetingTypesBlock(meetingTypes: MeetingType[]): string {
  return meetingTypes
    .map((mt) => `### ${mt.title}\n${mt.shortDescription}\n\n${mt.prompt}`)
    .join('\n\n');
}

function meetingHeaderBlock(meeting: Meeting, meetingTypes: MeetingType[]): string {
  return `# הפגישה

כותרת: ${meeting.title}

## סוג/י הפגישה
${meetingTypesBlock(meetingTypes)}

## מה רוצים להשיג / מה בונים
${meeting.objective}

## קבצי רקע משותפים לכל המשתתפים
${buildFilesBlock(meeting.files)}`;
}

function formatTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return '(עדיין לא נאמר דבר)';
  return transcript
    .map((e) => {
      const roundPart = e.round != null ? `, סבב ${e.round}` : '';
      return `[${PHASE_LABELS_HE[e.phase]}${roundPart}] ${e.speakerName}: ${e.text}`;
    })
    .join('\n\n');
}

function formatConflicts(conflicts: OpeningOutput['conflicts']): string {
  return conflicts
    .map((c, i) => `${i + 1}. ${c.topic} — ${c.sides} (חלוקים: ${c.whoDisagrees.join(', ')})`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Phase 0 — prep (parallel, no visibility into other personas' output)
// ---------------------------------------------------------------------------

export function buildPrepUserMessage(meeting: Meeting, meetingTypes: MeetingType[]): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# המשימה שלך עכשיו

זו הכנה פרטית לפגישה — אף משתתף אחר לא רואה את מה שאתה כותב כאן, וגם אתה לא רואה
את מה שהם כותבים. ענה אך ורק מנקודת המבט שלך, בלי לנחש מה אחרים יגידו ובלי לנסות
להגיע להסכמה מראש. תן:
- understanding: תיאור קצר (2-4 משפטים) של הבנתך את מטרת הפגישה ומה על הפרק, מהזווית שלך.
- concerns: בדיוק 3 חששות או סיכונים שהכי מטרידים אותך בהקשר הזה.
- questions: בדיוק 3 שאלות שהיית שואל/ת בתחילת הפגישה הזו.`;
}

// ---------------------------------------------------------------------------
// Phase 1 — opening (facilitator, single call)
// ---------------------------------------------------------------------------

export function buildOpeningUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  participants: Persona[],
  prepResults: Map<string, PrepOutput>
): string {
  const prepBlock = participants
    .map((p) => {
      const prep = prepResults.get(p.id);
      if (!prep) {
        return `### ${p.name} (${p.role})\n(לא התקבלה הכנה — יש להתעלם מהמשתתף הזה בשלב הזה)`;
      }
      return `### ${p.name} (${p.role})
הבנה: ${prep.understanding}
חששות: ${prep.concerns.map((c) => `- ${c}`).join('\n')}
שאלות: ${prep.questions.map((q) => `- ${q}`).join('\n')}`;
    })
    .join('\n\n');

  return `${meetingHeaderBlock(meeting, meetingTypes)}

# הכנה פרטית שכל משתתף הגיש (לפני שראה את האחרים)

${prepBlock}

# המשימה שלך עכשיו

בהתבסס על ההכנות האלה, בלבד, כתוב:
- framing: מסגור קצר (2-4 משפטים) של הפגישה — מה על הפרק ולאן שואפים להגיע.
- conflicts: בין 2 ל-4 התנגשויות ממוקדות בין עמדות המשתתפים, שאתה מזהה מתוך ההכנות
  שלהם (לא מומצאות). לכל התנגשות ציין נושא, את שתי הצדדים בקצרה, ואת שמות המשתתפים
  שנמצאים בכל צד. אל תמציא הסכמה שלא קיימת ואל תיצור התנגשות מלאכותית אם אין כזו —
  אבל אם יש חוסר בהירות או שתיקה על שאלה חשובה, ציין זאת גם כן כנקודה למעקב.`;
}

// ---------------------------------------------------------------------------
// Phase 2 — discussion (N rounds, sequential turns)
// ---------------------------------------------------------------------------

/**
 * Stable prefix for a discussion-turn user message: header + framing +
 * conflicts + transcript-so-far, with no per-round content in it. Because
 * `transcriptSoFar` only ever grows by appending (never rewriting past
 * entries), this text is a byte-for-byte prefix of what the same persona
 * will see on their next turn — the precondition for `cache_control` on
 * this block to actually produce cache reads across rounds (spec P4.3).
 * The round-specific instruction (which does change every turn) is a
 * separate, deliberately un-cached block — see `buildDiscussionInstructionBlock`.
 */
export function buildDiscussionContextBlock(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  opening: OpeningOutput,
  transcriptSoFar: TranscriptEntry[]
): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# מסגור הפגישה (מהמנחה)
${opening.framing}

# ההתנגשויות שזוהו
${formatConflicts(opening.conflicts)}

# מה נאמר עד כה
${formatTranscript(transcriptSoFar)}`;
}

/** The volatile part of a discussion turn — changes every round, so it stays out of the cached block above. */
export function buildDiscussionInstructionBlock(persona: Persona, round: number, totalRounds: number): string {
  return `# המשימה שלך עכשיו (סבב ${round} מתוך ${totalRounds})

זהו תורך לדבר, כ${persona.role}. הנחיות מחייבות:
- הגב **ישירות** למה שנאמר בפועל בתמליל למעלה — ציין מי אמר מה ולמה אתה מסכים,
  חולק, או רוצה להוסיף עליו. אל תחזור על העמדה שהצגת בשלב ההכנה כאילו זו הפעם
  הראשונה שאתה מדבר.
- אם עולה שאלה או נושא שאין לך מידע עליו — אמור זאת במפורש ("אין לי את המידע הזה,
  צריך לבדוק מול X"). זו תשובה טובה, לא כישלון.
- אם ההתנגשויות שלמעלה נוגעות אליך — קח בהן עמדה, אל תתחמק.
- אורך התשובה: 80-200 מילה, טקסט חופשי (לא JSON, בלי כותרות).`;
}

// ---------------------------------------------------------------------------
// Phase 3 — convergence (facilitator, single call)
// ---------------------------------------------------------------------------

export function buildConvergenceUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  transcript: TranscriptEntry[]
): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# תמליל הדיון המלא
${formatTranscript(transcript)}

# המשימה שלך עכשיו

סכם בטקסט חופשי (150-300 מילה): מה סוכם בפועל, מה נשאר פתוח, ומי צריך להחליט על
מה שנשאר פתוח. היצמד למה שנאמר בתמליל — אל תוסיף החלטות שלא התקבלו בפועל.`;
}

// ---------------------------------------------------------------------------
// Phase 4 — extraction (facilitator, single call, structured output)
// ---------------------------------------------------------------------------

export function buildExtractionUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  participants: Persona[],
  transcript: TranscriptEntry[],
  convergenceSummary: string
): string {
  const participantsList = participants.map((p) => `- ${p.name} (${p.role})`).join('\n');
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# משתתפים
${participantsList}

# תמליל הדיון המלא
${formatTranscript(transcript)}

# סיכום ההתכנסות (מהמנחה)
${convergenceSummary}

# המשימה שלך עכשיו

חלץ מהפגישה הזו את כל השדות הנדרשים בסכימה: summary, decisions, openQuestions,
conflicts, risks, tasks, modelAssumptions.

דגשים מחייבים:
- כל משימה ב-tasks חייבת לכלול assumption (ההנחה שעליה המשימה נשענת) ו-
  riskIfAssumptionWrong (מה הסיכון אם ההנחה הזו מתבררת כשגויה). אל תשאיר שדות
  אלה גנריים — התבסס על מה שבאמת נאמר או לא נאמר בדיון.
- ownerName של כל משימה חייב להיות שם של אחד המשתתפים שלמעלה, או "לא שויך" אם
  באמת אין בעלים ברור מהדיון.
- dependsOn מתייחס לכותרות (title) של משימות אחרות ברשימת tasks.
- כל דבר שאתה, המנחה, השלמת בעצמך ולא נאמר במפורש בדיון (הנחת עבודה, פרשנות,
  השלמת פרט חסר) — ציין אותו במפורש ברשימת modelAssumptions. אל תשלב השלמות
  כאלה בשקט בתוך summary/decisions/tasks בלי לסמן אותן גם שם.`;
}

// ---------------------------------------------------------------------------
// Post-meeting follow-up questions (spec §6)
// ---------------------------------------------------------------------------

/**
 * Uses the exact same system blocks as the persona's live-meeting calls
 * (§3.2, cache stability) — the caller passes `buildPersonaSystemBlocks(org,
 * persona)` or `buildFacilitatorSystemBlocks(org)` alongside this message.
 */
export function buildFollowUpUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  transcript: TranscriptEntry[],
  previousFollowUps: FollowUp[],
  question: string
): string {
  const previousQA = previousFollowUps.length
    ? previousFollowUps.map((f, i) => `${i + 1}. ש: ${f.question}\n   ת: ${f.answer}`).join('\n\n')
    : '(אין שאלות המשך קודמות בפגישה זו)';

  return `${meetingHeaderBlock(meeting, meetingTypes)}

# תמליל הפגישה המלא (הפגישה כבר הסתיימה)
${formatTranscript(transcript)}

# שאלות המשך קודמות שנשאלת באותה פגישה
${previousQA}

# המשימה שלך עכשיו

הפגישה הסתיימה. מישהו שואל אותך שאלת המשך, מחוץ למסגרת הפגישה עצמה. ענה
מנקודת המבט שלך בלבד, בהתבסס אך ורק על מה שנאמר בפועל בתמליל למעלה ועל
הידע שיש לך מהפרומפט האישי שלך.
- אם התשובה דורשת מידע שאין לך — אמור זאת במפורש ("אין לי את המידע הזה,
  צריך לבדוק מול X"). זו תשובה טובה ולגיטימית, לא כישלון.
- אל תמציא עובדות או החלטות שלא נאמרו בתמליל.
- ענה בטקסט חופשי בלבד (לא JSON, בלי כותרות), עד כ-150 מילה.

השאלה: ${question}`;
}

// ---------------------------------------------------------------------------
// System transcript lines (budget exhaustion / persona failure / refusal)
// ---------------------------------------------------------------------------

export function budgetExhaustedLine(personaName: string): string {
  return `${personaName} הגיע/ה לתקציב הקריאות שהוקצה לה/לו לפגישה זו, ולכן לא תשתתף/ישתתף בהמשך הדיון.`;
}

export function personaErrorLine(personaName: string, errorMessage: string): string {
  return `אירעה שגיאה בקבלת תגובה מ-${personaName} (${errorMessage}). ממשיכים בפגישה בלעדיה/בלעדיו בשלב הזה.`;
}

export function personaRefusedLine(personaName: string): string {
  return `${personaName} סירב/ה לספק תגובה בשלב הזה. ממשיכים בפגישה.`;
}
