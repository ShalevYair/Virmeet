// Virmeet — JSON schemas for structured model output (spec §0, §4).
// Every schema here is passed verbatim as `responseJsonSchema` to callModel().
// Gemini's structured-output mode requires `additionalProperties: false` and
// every property listed in `required` — both are enforced on every object
// below, including nested ones.

/** Phase 0 (`prep`) — one persona's private read of the meeting, unseen by peers. */
export const PREP_SCHEMA = {
  type: 'object',
  properties: {
    understanding: {
      type: 'string',
      description: 'תיאור קצר של הבנת הפרסונה את מטרת הפגישה ואת מה שעל הפרק, מנקודת המבט שלה.',
    },
    concerns: {
      type: 'array',
      description: 'בדיוק שלושה חששות או סיכונים מרכזיים מנקודת המבט של הפרסונה.',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 3,
    },
    questions: {
      type: 'array',
      description: 'בדיוק שלוש שאלות שהפרסונה הייתה שואלת בפתיחת הפגישה.',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 3,
    },
    filesToReadInDepth: {
      type: 'array',
      description:
        'שמות מדויקים (עד 3) מתוך "קבצי ידע זמינים ב-Drive" שהפרסונה מבקשת לקרוא במלואם, ולא רק את תקצירם. מערך ריק אם אין כאלה או שאין קבצי Drive זמינים.',
      items: { type: 'string' },
      maxItems: 3,
    },
  },
  required: ['understanding', 'concerns', 'questions', 'filesToReadInDepth'],
  additionalProperties: false,
} as const;

/** Phase 1 (`opening`) — facilitator framing + explicit conflicts between participants. */
export const OPENING_SCHEMA = {
  type: 'object',
  properties: {
    framing: {
      type: 'string',
      description: 'מסגור קצר של הפגישה: מה על הפרק ולאן שואפים להגיע.',
    },
    conflicts: {
      type: 'array',
      description: 'בין 2 ל-4 התנגשויות ממוקדות בין עמדות המשתתפים, שזוהו מתוך שלב ההכנה.',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'נושא ההתנגשות.' },
          sides: { type: 'string', description: 'תיאור העמדות המנוגדות.' },
          whoDisagrees: {
            type: 'array',
            description: 'שמות המשתתפים (או תפקידיהם) שנמצאים בצדדים שונים של ההתנגשות.',
            items: { type: 'string' },
          },
        },
        required: ['topic', 'sides', 'whoDisagrees'],
        additionalProperties: false,
      },
      minItems: 2,
      maxItems: 4,
    },
  },
  required: ['framing', 'conflicts'],
  additionalProperties: false,
} as const;

/**
 * Phase 4 (`extraction`) — the full MeetingResult, minus `tasks[].id` which
 * the runner assigns itself after parsing (the model references tasks by
 * title in `dependsOn`, per spec §1).
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'כותרת קצרה ותמציתית (עד כ-8 מילים) שמשקפת את מה שבאמת נדון בפגישה בפועל — לא את סוג הפגישה או נוסח גנרי.',
    },
    summary: { type: 'string', description: 'סיכום קצר של הפגישה כולה.' },
    decisions: {
      type: 'array',
      description: 'החלטות שהתקבלו בפועל במהלך הפגישה.',
      items: { type: 'string' },
    },
    openQuestions: {
      type: 'array',
      description: 'שאלות שנותרו פתוחות בסיום הפגישה.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          whoShouldAnswer: { type: 'string', description: 'מי אמור לספק תשובה לשאלה הזו.' },
          blocking: { type: 'boolean', description: 'האם השאלה חוסמת המשך התקדמות.' },
        },
        required: ['question', 'whoShouldAnswer', 'blocking'],
        additionalProperties: false,
      },
    },
    conflicts: {
      type: 'array',
      description: 'התנגשויות בין עמדות שעלו במהלך הדיון (כולל כאלה שלא נפתרו).',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          sides: { type: 'string' },
        },
        required: ['topic', 'sides'],
        additionalProperties: false,
      },
    },
    risks: {
      type: 'array',
      description: 'סיכונים שזוהו במהלך הפגישה.',
      items: { type: 'string' },
    },
    tasks: {
      type: 'array',
      description: 'משימות לביצוע שנגזרות מהפגישה.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          ownerName: {
            type: 'string',
            description: 'שם בעל המשימה (מבין המשתתפים), או "לא שויך" אם אין בעלים ברור.',
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          dependsOn: {
            type: 'array',
            description: 'כותרות של משימות אחרות שהמשימה הזו תלויה בהן.',
            items: { type: 'string' },
          },
          assumption: {
            type: 'string',
            description: 'ההנחה שעליה המשימה נשענת.',
          },
          riskIfAssumptionWrong: {
            type: 'string',
            description: 'הסיכון אם ההנחה הזו מתבררת כשגויה.',
          },
        },
        required: [
          'title',
          'description',
          'ownerName',
          'priority',
          'dependsOn',
          'assumption',
          'riskIfAssumptionWrong',
        ],
        additionalProperties: false,
      },
    },
    modelAssumptions: {
      type: 'array',
      description: 'כל מה שהמודל השלים בעצמו בזמן החילוץ (לא נאמר במפורש בדיון) — מסומן במפורש.',
      items: { type: 'string' },
    },
  },
  required: ['title', 'summary', 'decisions', 'openQuestions', 'conflicts', 'risks', 'tasks', 'modelAssumptions'],
  additionalProperties: false,
} as const;

/** Shape produced by the model for extraction, before the runner assigns task ids and owner persona ids. */
export interface ExtractionModelOutput {
  title: string;
  summary: string;
  decisions: string[];
  openQuestions: { question: string; whoShouldAnswer: string; blocking: boolean }[];
  conflicts: { topic: string; sides: string }[];
  risks: string[];
  tasks: {
    title: string;
    description: string;
    ownerName: string;
    priority: 'high' | 'medium' | 'low';
    dependsOn: string[];
    assumption: string;
    riskIfAssumptionWrong: string;
  }[];
  modelAssumptions: string[];
}
