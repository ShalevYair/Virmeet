// Virmeet — data model (spec §0-1). Do not change model IDs or add date suffixes.

export const MODELS = {
  persona: 'claude-sonnet-5', // ברירת מחדל לפרסונה
  facilitator: 'claude-opus-5', // מנחה + חילוץ משימות
} as const;

export const AVAILABLE_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];

export interface AttachedFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string; // יחסי ל-data/
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
  model: string; // ברירת מחדל 'claude-sonnet-5'
  webAccess: boolean; // האם יכולה לחפש ברשת תוך כדי הפגישה
  maxApiCalls: number; // תקציב קריאות מודל לפגישה אחת (1-20)
  maxWebSearches: number; // max_uses לכלי החיפוש (0-10)
  files: AttachedFile[]; // קבצי רקע פרטיים לפרסונה
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

export type MeetingPhase = 'prep' | 'opening' | 'discussion' | 'convergence' | 'extraction';
export type MeetingStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TranscriptEntry {
  id: string;
  phase: MeetingPhase;
  speakerId: string; // personaId | 'facilitator' | 'system'
  speakerName: string;
  round?: number;
  text: string;
  webSearches?: {
    query: string;
    results?: { title: string; url: string }[];
    error?: string; // Hebrew — see src/lib/anthropic.ts WEB_SEARCH_ERROR_HE
  }[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number; // estimate — see src/lib/pricing.ts
  };
  createdAt: string;
}

export interface MeetingTask {
  id: string;
  title: string;
  description: string;
  ownerPersonaId: string | null;
  ownerName: string; // "לא שויך" אם null
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

export interface Meeting {
  id: string;
  title: string;
  meetingTypeIds: string[]; // לפחות אחד
  objective: string; // טקסט חופשי: מה רוצים להשיג / מה בונים
  participantIds: string[]; // לפחות 2
  files: AttachedFile[]; // קבצי רקע משותפים
  discussionRounds: number; // 1-4, ברירת מחדל 2
  status: MeetingStatus;
  transcript: TranscriptEntry[];
  result: MeetingResult | null;
  error: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    apiCalls: number;
    costUsd: number; // estimate — see src/lib/pricing.ts
  };
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
