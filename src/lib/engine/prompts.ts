// Virmeet — Hebrew prompt builders for the meeting engine (spec §4).
//
// Caching note: system blocks are ordered stable-and-shared-first —
// [orgBlock, sharedFilesBlock, personaPrompt, personaFilesBlock] for personas,
// [orgBlock, sharedFilesBlock, facilitatorPrompt] for the facilitator — and
// none of those change during a meeting run; only `messages` (the user turn)
// changes between prep/opening/discussion calls. That stability is what lets
// Gemini's implicit context caching hit across every call of a meeting,
// persona and facilitator alike, since [orgBlock, sharedFilesBlock] is an
// identical prefix for both. Unlike explicit cache-breakpoint APIs, Gemini
// caches automatically — there's nothing to mark, only a shared prefix to
// preserve. Do not fold per-phase or per-round content into the system
// blocks.

import { AttachedFile, ChatMessage, Meeting, MeetingResult, MeetingType, OrgSettings, Persona, TranscriptEntry } from '../types';
import { SystemBlock } from '../llm-types';
import type { PersonaKnowledgeFile } from './drive-knowledge';
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

/** Renders a set of background files as prompt text under `heading` (may be empty). */
function buildFilesBlock(files: Persona['files'] | Meeting['files'], heading: string): string {
  if (files.length === 0) {
    return `${heading}\n\nאין קבצי רקע מצורפים.`;
  }
  const parts = files.map((f) => {
    const body = f.extractionError
      ? `[לא ניתן היה לחלץ טקסט מהקובץ הזה: ${f.extractionError}]`
      : f.extractedText || '[הקובץ ריק]';
    return `### ${f.name}\n${body}`;
  });
  return `${heading}\n\n${parts.join('\n\n')}`;
}

const SHARED_FILES_HEADING = '# קבצי רקע משותפים לכל משתתפי הפגישה';
const PRIVATE_FILES_HEADING = '# קבצי רקע פרטיים שלך (אף אחד אחר לא רואה אותם)';
const DRIVE_INDEX_HEADING =
  '# קבצי ידע זמינים ב-Drive (תקצירים בלבד)\n\nאלה תקצירים קצרים בלבד. בשלב ההכנה (prep) אפשר לבקש לקרוא את התוכן המלא של עד כמה מהם, דרך filesToReadInDepth.';
const DRIVE_DEEP_READ_HEADING = '# קבצים מ-Drive שביקשת לקרוא לעומק בשלב ההכנה';

/** Renders the Drive knowledge-folder index (name + summary only, no full text) — see engine/drive-knowledge.ts. */
function buildDriveIndexBlock(files: PersonaKnowledgeFile[]): string {
  const parts = files.map((f) => `- ${f.name}: ${f.summary}`);
  return `${DRIVE_INDEX_HEADING}\n\n${parts.join('\n')}`;
}

/**
 * [orgBlock, sharedFilesBlock, personaPrompt, personaFilesBlock, driveIndexBlock?, driveDeepReadBlock?].
 * The first four are stable for the whole meeting; `driveKnowledge.indexSummary` (from the
 * pre-prep refresh, engine/drive-knowledge.ts) is available from prep onward, but
 * `driveKnowledge.deepReadFiles` only exists *after* prep decided what to request — so it's
 * omitted for the prep call itself and only appended for calls from opening/discussion onward.
 */
export function buildPersonaSystemBlocks(
  org: OrgSettings,
  persona: Persona,
  meeting: Meeting,
  driveKnowledge: { indexSummary?: PersonaKnowledgeFile[]; deepReadFiles?: AttachedFile[] } = {}
): SystemBlock[] {
  const blocks: SystemBlock[] = [
    { type: 'text', text: buildOrgBlock(org) },
    { type: 'text', text: buildFilesBlock(meeting.files, SHARED_FILES_HEADING) },
    { type: 'text', text: persona.prompt },
    { type: 'text', text: buildFilesBlock(persona.files, PRIVATE_FILES_HEADING) },
  ];
  if (driveKnowledge.indexSummary && driveKnowledge.indexSummary.length > 0) {
    blocks.push({ type: 'text', text: buildDriveIndexBlock(driveKnowledge.indexSummary) });
  }
  if (driveKnowledge.deepReadFiles && driveKnowledge.deepReadFiles.length > 0) {
    blocks.push({ type: 'text', text: buildFilesBlock(driveKnowledge.deepReadFiles, DRIVE_DEEP_READ_HEADING) });
  }
  return blocks;
}

const FACILITATOR_ROLE_PROMPT = `אתה המנחה (facilitator) של הפגישה. אתה לא צד בדיון ואין לך אינטרס אישי בתוצאה —
תפקידך הוא לארגן, למסגר, לזהות מחלוקות במפורש, ולסכם באופן נאמן למה שנאמר בפועל.
אל תמציא הסכמה שלא הייתה, ואל תטשטש מחלוקת אמיתית כדי שהפלט ייראה "נקי" יותר.
כשמידע חסר או לא נאמר במפורש בדיון, סמן זאת ככזה — אל תשלים אותו כעובדה.`;

/** [orgBlock, sharedFilesBlock, facilitatorRolePrompt] — stable across opening/convergence/extraction; shares the [orgBlock, sharedFilesBlock] prefix with persona calls for cache hits. */
export function buildFacilitatorSystemBlocks(org: OrgSettings, meeting: Meeting): SystemBlock[] {
  return [
    { type: 'text', text: buildOrgBlock(org) },
    { type: 'text', text: buildFilesBlock(meeting.files, SHARED_FILES_HEADING) },
    { type: 'text', text: FACILITATOR_ROLE_PROMPT },
  ];
}

function meetingTypesBlock(meetingTypes: MeetingType[]): string {
  return meetingTypes
    .map((mt) => `### ${mt.title}\n${mt.shortDescription}\n\n${mt.prompt}`)
    .join('\n\n');
}

export function meetingHeaderBlock(meeting: Meeting, meetingTypes: MeetingType[]): string {
  return `# הפגישה

כותרת: ${meeting.title || '(כותרת תיקבע בסיום הפגישה)'}

## סוג/י הפגישה
${meetingTypesBlock(meetingTypes)}

## מה רוצים להשיג / מה בונים
${meeting.objective}`;
}

export function formatTranscript(transcript: TranscriptEntry[]): string {
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
- questions: בדיוק 3 שאלות שהיית שואל/ת בתחילת הפגישה הזו.
- filesToReadInDepth: אם יש לך למעלה "קבצי ידע זמינים ב-Drive" ואתה צריך את התוכן
  המלא של אחד או יותר מהם (לא רק את התקציר) כדי להכין תשובה מבוססת — ציין את
  שמותיהם המדויקים, עד 3 קבצים. אם אין קבצים כאלה או שאין בהם צורך, מערך ריק.`;
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

export function buildDiscussionUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  persona: Persona,
  round: number,
  totalRounds: number,
  opening: OpeningOutput,
  transcriptSoFar: TranscriptEntry[]
): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# מסגור הפגישה (מהמנחה)
${opening.framing}

# ההתנגשויות שזוהו
${formatConflicts(opening.conflicts)}

# מה נאמר עד כה (סבב ${round} מתוך ${totalRounds})
${formatTranscript(transcriptSoFar)}

# המשימה שלך עכשיו

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

חלץ מהפגישה הזו את כל השדות הנדרשים בסכימה: title, summary, decisions,
openQuestions, conflicts, risks, tasks, modelAssumptions.

דגשים מחייבים:
- title: כותרת קצרה ותמציתית (עד כ-8 מילים) שמשקפת את מה שבאמת נדון בפגישה
  הזו בפועל — לא ניסוח גנרי של סוג הפגישה.
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
// Post-meeting chat — free-form Q&A (general or directed at one persona) and
// additional discussion rounds, both available once a meeting has completed
// (engine/chat.ts). Unlike the phased prompts above, these aren't part of
// the deterministic state machine, so they don't need to share the
// [orgBlock, sharedFilesBlock] caching prefix discipline as tightly — they
// still reuse buildFacilitatorSystemBlocks/buildPersonaSystemBlocks as-is.
// ---------------------------------------------------------------------------

const CHAT_HISTORY_LIMIT = 10;

/** Renders this chat thread's own prior turns (already filtered to one mode/persona by the caller), capped to the most recent `CHAT_HISTORY_LIMIT`. */
function formatChatHistory(priorChat: ChatMessage[]): string {
  if (priorChat.length === 0) return '';
  const recent = priorChat.slice(-CHAT_HISTORY_LIMIT);
  const lines = recent
    .map((c) => `שאלה: ${c.question}\nתשובה: ${c.refused ? '(סורבה תשובה לשאלה הזו)' : c.answer}`)
    .join('\n\n');
  return `\n\n# שיחת ההמשך עד כה (באותו נושא)\n${lines}`;
}

function formatMeetingResultBlock(result: MeetingResult | null): string {
  if (!result) return '(לא הופק סיכום מובנה לפגישה זו)';
  return `${result.summary}\n\nהחלטות:\n${
    result.decisions.length ? result.decisions.map((d) => `- ${d}`).join('\n') : '(אין החלטות מתועדות)'
  }`;
}

/** A single question the user asks about the meeting as a whole, answered by the facilitator (not any one persona). */
export function buildGeneralChatUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  transcript: TranscriptEntry[],
  result: MeetingResult | null,
  priorChat: ChatMessage[],
  question: string
): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# תמליל הפגישה המלא
${formatTranscript(transcript)}

# סיכום התוצאות של הפגישה
${formatMeetingResultBlock(result)}${formatChatHistory(priorChat)}

# המשימה שלך עכשיו

הפגישה הזו כבר הסתיימה. משתמש שואל עכשיו שאלת המשך כללית עליה — לא מנקודת
המבט של משתתף מסוים, אלא כמנחה שמכיר את כל התמליל והתוצאות. ענה ישירות על סמך
מה שבאמת נאמר ונקבע בפגישה; אם משהו לא נדון או לא הוכרע בפועל — אמור זאת
במפורש ואל תמציא תשובה. תשובה בטקסט חופשי, עד כ-200 מילה.

# השאלה
${question}`;
}

/** A single question the user directs at one specific persona, after the meeting — answered in character, from that persona's own point of view. */
export function buildPersonaChatUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  persona: Persona,
  transcript: TranscriptEntry[],
  result: MeetingResult | null,
  priorChat: ChatMessage[],
  question: string
): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# תמליל הפגישה המלא (כולל מה שאמרת בה בעצמך)
${formatTranscript(transcript)}

# סיכום התוצאות של הפגישה
${formatMeetingResultBlock(result)}${formatChatHistory(priorChat)}

# המשימה שלך עכשיו

הפגישה כבר הסתיימה. משתמש פונה אליך ישירות, אחרי הפגישה, עם שאלת המשך — כ
${persona.role}. ענה מנקודת המבט שלך בלבד, בהתבסס על מה שנאמר בפגישה ועל הידע
והפרומפט שלך. אם השאלה נוגעת למשהו שלא היה חלק מהפגישה או שאין לך מידע עליו —
אמור זאת במפורש, כמו בכל שלב אחר בסימולציה. תשובה בטקסט חופשי, עד כ-200 מילה.

# השאלה
${question}`;
}

/** One persona's turn in an additional discussion round opened after the meeting ended — same voice/rules as buildDiscussionUserMessage, but framed around a user-supplied topic instead of the facilitator's original opening. */
export function buildAdditionalRoundUserMessage(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  persona: Persona,
  round: number,
  transcriptSoFar: TranscriptEntry[],
  topic: string
): string {
  return `${meetingHeaderBlock(meeting, meetingTypes)}

# מה נאמר עד כה (כולל סבבי הדיון המקוריים ותוצאות הפגישה)
${formatTranscript(transcriptSoFar)}

# המשימה שלך עכשיו

הפגישה המקורית הסתיימה, אבל נפתח סבב דיון נוסף (סבב ${round}) כדי להמשיך לדון
בנושא הבא שהעלה מי שיזם את הפגישה:

"${topic}"

הגב כ${persona.role}, **ישירות** לנושא הזה ולמה שכבר נאמר בפגישה המקורית (ציין
מי אמר מה כשרלוונטי). אם עולה שאלה שאין לך מידע עליה — אמור זאת במפורש ("אין
לי את המידע הזה, צריך לבדוק מול X"). אורך התשובה: 80-200 מילה, טקסט חופשי (לא
JSON, בלי כותרות).`;
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

export function personaTruncatedInPrepLine(personaName: string): string {
  return `התשובה של ${personaName} נקטעה בשל מגבלת אורך ולכן לא נכללה בשלב ההכנה.`;
}

export function facilitatorTruncatedInOpeningLine(): string {
  return 'תשובת המנחה בשלב הפתיחה נקטעה בשל מגבלת אורך. ממשיכים עם מסגור בסיסי.';
}

/** Appended to a discussion entry's text when the response was cut off — the reader must be able to tell a truncated statement from a complete one. */
export function discussionTruncatedSuffix(): string {
  return '\n\n[הערת מערכת: התגובה נקטעה בשל מגבלת אורך]';
}

export function extractionTruncatedError(): string {
  return 'חילוץ תוצאות הפגישה נכשל: תשובת המנחה בשלב החילוץ נקטעה בשל מגבלת אורך (max_tokens), ולא ניתן היה לחלץ ממנה משימות ותוצאות.';
}
