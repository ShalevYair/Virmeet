// Virmeet — data model (spec §0-1). Do not change model IDs or add date suffixes.

// Google's three Gemini tiers, chosen once per meeting (not per persona) and
// used for every call in that meeting — facilitator and personas alike.
export const AVAILABLE_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];

export const DEFAULT_MODEL: AvailableModel = 'gemini-3.6-flash';

/** True iff `model` is one of the ids this app actually knows how to route (see AVAILABLE_MODELS). */
export function isKnownModel(model: string): boolean {
  return (AVAILABLE_MODELS as readonly string[]).includes(model);
}

export interface AttachedFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string; // ריק ('') להעלאות דרך הדפדפן (store.ts) — משמעותי רק לקבצי seed (public/seed/files/, ראו seed-loader.ts), משריד לגרסה עם אחסון בדיסק (data/)
  extractedText: string; // '' אם החילוץ נכשל
  extractionError?: string;
  addedAt: string; // ISO
}

export interface Persona {
  id: string;
  name: string; // "ארכיטקט תשתיות"
  role: string; // תפקיד קצר להצגה
  organization: string; // "אגף טכנולוגיות, משרד התחבורה"
  color: string; // hex, לצבע האווטאר
  prompt: string; // הפרומט המלא בעברית — ניתן לעריכה מלאה
  webAccess: boolean; // האם יכולה לחפש ברשת תוך כדי הפגישה
  maxApiCalls: number; // תקציב קריאות מודל לפגישה אחת (1-20)
  maxWebSearches: number; // max_uses לכלי החיפוש (0-10)
  files: AttachedFile[]; // קבצי רקע פרטיים לפרסונה
  driveFolderId?: string; // מזהה תיקיית הידע של הפרסונה ב-Drive (VIRMEET/<שם הפרסונה>/), אם חוברה
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingType {
  // "סוג מטרת פגישה"
  id: string;
  title: string; // "שיחת התנעה"
  shortDescription: string; // משפט-שניים
  prompt: string; // הפרומט המפורט שמזריק למנחה ולפרסונות
  isBuiltIn: boolean; // seed — ניתן לערוך אבל לא למחוק
  createdAt: string;
  updatedAt: string;
}

// When the model can't tie a task to a specific participant, the engine
// (runner.ts) assigns it to the project manager instead of leaving it
// ownerless — see public/seed/personas/project-manager.json.
export const UNASSIGNED_TASK_OWNER_FALLBACK = 'מנהל פרויקט';

export type MeetingPhase = 'prep' | 'opening' | 'discussion' | 'convergence' | 'extraction';
export type MeetingStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TranscriptEntry {
  id: string;
  phase: MeetingPhase;
  speakerId: string; // personaId | 'facilitator' | 'system'
  speakerName: string;
  round?: number;
  text: string;
  webSearches?: { query: string }[];
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  createdAt: string;
}

export interface MeetingTask {
  id: string;
  title: string;
  description: string;
  ownerPersonaId: string | null;
  ownerName: string; // "מנהל פרויקט" כברירת מחדל כשלא היה בעלים ברור מהדיון
  priority: 'high' | 'medium' | 'low';
  dependsOn: string[]; // כותרות/מזהים של משימות אחרות
  assumption: string; // ההנחה שעליה המשימה נשענת
  riskIfAssumptionWrong: string;
}

export interface MeetingResult {
  summary: string;
  decisions: string[];
  openQuestions: { question: string; whoShouldAnswer: string; blocking: boolean }[];
  conflicts: { topic: string; sides: string }[];
  risks: string[];
  tasks: MeetingTask[];
  modelAssumptions: string[]; // מה שהמודל השלים בעצמו — מסומן במפורש
}

// Post-meeting chat (spec: post-session chat management) — available once a
// meeting reaches status 'completed', from either the just-finished run's
// own page or by reopening that meeting later; both are the same route
// (meetings/view), so no separate "past meeting" concept is needed.
//
// 'general'/'persona' modes are Q&A: each turn is one question + one answer,
// stored as a single record (not split user/assistant messages) since there
// is no free-form back-and-forth beyond one question at a time. 'round' mode
// is different in kind — it runs a real additional discussion round and
// appends ordinary TranscriptEntry rows to Meeting.transcript instead, so it
// is never represented here.
export type ChatMode = 'general' | 'persona';

export interface ChatMessage {
  id: string;
  mode: ChatMode;
  personaId?: string; // set when mode === 'persona' — who was asked
  question: string;
  answer: string; // '' when refused
  refused?: boolean;
  createdAt: string; // ISO
}

export interface Meeting {
  id: string;
  title: string; // ריק עד שהפגישה מסתיימת — המנחה קובע כותרת בשלב extraction
  meetingTypeIds: string[]; // לפחות אחד
  objective: string; // טקסט חופשי: מה רוצים להשיג / מה בונים
  participantIds: string[]; // לפחות 2
  creatorParticipates: boolean; // האם יוצר הפגישה (המשתמש) משתתף בעצמו בכל סבב דיון
  model: AvailableModel; // המודל שישמש את כל המשתתפים והמנחה בפגישה זו
  files: AttachedFile[]; // קבצי רקע משותפים
  discussionRounds: number; // 1-4, ברירת מחדל 2 — לאחר סיום, יכול לגדול דרך "סבב דיון נוסף" בצ'אט שלאחר הפגישה
  status: MeetingStatus;
  transcript: TranscriptEntry[];
  result: MeetingResult | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; apiCalls: number };
  chat: ChatMessage[]; // צ'אט חופשי לאחר סיום הפגישה (שאלות כלליות / לפרסונה ספציפית) — ראו ChatMessage
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OrgSettings {
  organizationName: string; // "משרד התחבורה"
  description: string; // רקע ארגוני שמוזרק לכל הפרסונות
  constraints: string; // תקציב, רגולציה, אילוצים
  updatedAt: string;
}
