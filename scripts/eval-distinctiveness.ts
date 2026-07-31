// Virmeet — persona distinctiveness eval (spec §7).
//
// Usage: npm run eval:personas -- <meetingId>
//
// Loads a meeting's discussion-phase transcript, strips speaker identity,
// shuffles the statements, and asks the facilitator model to re-attribute
// each one to a participant from the meeting. Compares accuracy against the
// random-guess baseline (1/N participants). Below 1.5x baseline, the
// personas aren't actually distinct — they're set dressing wearing
// different job titles, and the fix is to sharpen each persona's interests
// and knowledge asymmetry (spec §2, §3.1), not to add more prompt text.
//
// Runs as a plain Node script — Node 22's built-in TypeScript type-stripping
// means no ts-node/tsx/build step (spec §2: no new dependencies beyond
// vitest in stage 3). It only imports leaf lib modules that have no further
// extensionless relative imports of their own (src/lib/anthropic.ts,
// src/lib/types.ts — both self-contained); meeting/persona data is read
// directly from data/ rather than through src/lib/store.ts, whose internal
// imports aren't resolvable by plain `node` without a bundler.

import fs from 'fs';
import path from 'path';
import { callModel } from '../src/lib/anthropic.ts';
import { MODELS } from '../src/lib/types.ts';
import type { Meeting, Persona } from '../src/lib/types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function loadMeeting(id: string): Meeting {
  const filePath = path.join(DATA_DIR, 'meetings', `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`הפגישה "${id}" לא נמצאה (${filePath}).`);
  }
  return readJson<Meeting>(filePath);
}

function loadPersonas(): Persona[] {
  const filePath = path.join(DATA_DIR, 'personas.json');
  if (!fs.existsSync(filePath)) return [];
  return readJson<Persona[]>(filePath);
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Strips a speaker's own name/role from their statement — a cheap, common self-identification leak. */
export function redact(text: string, persona: Pick<Persona, 'name' | 'role'>): string {
  let redacted = text;
  for (const needle of [persona.name, persona.role]) {
    if (!needle) continue;
    redacted = redacted.split(needle).join('[פרסונה]');
  }
  return redacted;
}

export interface AnonStatement {
  label: string;
  actualSpeakerName: string;
  text: string;
}

export interface Assignment {
  label: string;
  speaker: string;
}

export function buildDistinctivenessSchema(participantNames: string[]) {
  return {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        description: 'שיוך כל אמירה מסומנת לדובר משוער מבין המשתתפים.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'התווית של האמירה (למשל "אמירה 3").' },
            speaker: { type: 'string', enum: participantNames, description: 'שם המשתתף המשוער.' },
          },
          required: ['label', 'speaker'],
          additionalProperties: false,
        },
      },
    },
    required: ['assignments'],
    additionalProperties: false,
  } as const;
}

export interface DistinctivenessReport {
  total: number;
  correct: number;
  accuracy: number;
  baseline: number;
  ratio: number;
  passed: boolean;
  perPersona: { name: string; correct: number; total: number }[];
  confusion: Map<string, Map<string, number>>;
}

const PASS_THRESHOLD = 1.5;

export function computeDistinctivenessReport(
  anonymized: AnonStatement[],
  assignments: Assignment[],
  participantNames: string[]
): DistinctivenessReport {
  const guessByLabel = new Map(assignments.map((a) => [a.label, a.speaker]));
  const perPersonaTotal = new Map<string, number>();
  const perPersonaCorrect = new Map<string, number>();
  const confusion = new Map<string, Map<string, number>>();

  let correct = 0;
  for (const s of anonymized) {
    const guess = guessByLabel.get(s.label) ?? '(לא סווג)';
    perPersonaTotal.set(s.actualSpeakerName, (perPersonaTotal.get(s.actualSpeakerName) ?? 0) + 1);
    if (guess === s.actualSpeakerName) {
      correct += 1;
      perPersonaCorrect.set(s.actualSpeakerName, (perPersonaCorrect.get(s.actualSpeakerName) ?? 0) + 1);
    }
    if (!confusion.has(s.actualSpeakerName)) confusion.set(s.actualSpeakerName, new Map());
    const row = confusion.get(s.actualSpeakerName)!;
    row.set(guess, (row.get(guess) ?? 0) + 1);
  }

  const total = anonymized.length;
  const accuracy = total > 0 ? correct / total : 0;
  const baseline = participantNames.length > 0 ? 1 / participantNames.length : 0;
  const ratio = baseline > 0 ? accuracy / baseline : 0;

  const perPersona = participantNames.map((name) => ({
    name,
    correct: perPersonaCorrect.get(name) ?? 0,
    total: perPersonaTotal.get(name) ?? 0,
  }));

  return { total, correct, accuracy, baseline, ratio, passed: ratio >= PASS_THRESHOLD, perPersona, confusion };
}

export function renderReport(report: DistinctivenessReport): string {
  const lines: string[] = [];
  lines.push('=== דוח נבדלות פרסונות ===\n');
  lines.push(`דיוק כולל: ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.total})`);
  lines.push(`קו בסיס (ניחוש אקראי): ${(report.baseline * 100).toFixed(1)}%`);
  lines.push(`יחס לקו הבסיס: ×${report.ratio.toFixed(2)}\n`);

  lines.push('דיוק לפי פרסונה:');
  for (const p of report.perPersona) {
    const pct = p.total > 0 ? ((p.correct / p.total) * 100).toFixed(1) : '—';
    lines.push(`  ${p.name}: ${pct}% (${p.correct}/${p.total})`);
  }

  lines.push('\nמטריצת בלבול (דובר בפועל -> מי המודל חשב שזה):');
  for (const [actual, guesses] of report.confusion) {
    const parts = Array.from(guesses.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `${g}: ${n}`)
      .join(', ');
    lines.push(`  ${actual} -> ${parts}`);
  }

  lines.push('\n=== פסק דין ===');
  if (report.passed) {
    lines.push(`✅ הפרסונות נבדלות מספיק (יחס ×${report.ratio.toFixed(2)} קו הבסיס, סף מעבר: ×${PASS_THRESHOLD}).`);
  } else {
    lines.push(
      `❌ הפרסונות אינן נבדלות; יש להקצין את האינטרסים ואת א-סימטריית הידע.\n` +
        `   (יחס ×${report.ratio.toFixed(2)} קו הבסיס, נדרש לפחות ×${PASS_THRESHOLD})`
    );
  }
  return lines.join('\n');
}

async function main() {
  const meetingId = process.argv[2];
  if (!meetingId) {
    console.error('שימוש: npm run eval:personas -- <meetingId>');
    process.exitCode = 1;
    return;
  }

  const meeting = loadMeeting(meetingId);
  const personas = loadPersonas();
  const personaById = new Map(personas.map((p) => [p.id, p]));

  const participants = meeting.participantIds
    .map((id) => personaById.get(id))
    .filter((p): p is Persona => p != null);

  if (participants.length < 2) {
    console.error('נדרשים לפחות שני משתתפים (עם פרסונה קיימת ב-data/personas.json) כדי להריץ את המדד.');
    process.exitCode = 1;
    return;
  }

  const discussionEntries = meeting.transcript.filter((e) => e.phase === 'discussion' && e.speakerId !== 'system');
  if (discussionEntries.length === 0) {
    console.error('אין שורות דיון בפגישה הזו — אין מה למדוד.');
    process.exitCode = 1;
    return;
  }

  const anonymized: AnonStatement[] = discussionEntries.map((entry, i) => {
    const persona = personaById.get(entry.speakerId);
    const text = persona ? redact(entry.text, persona) : entry.text;
    return { label: `אמירה ${i + 1}`, actualSpeakerName: entry.speakerName, text };
  });
  const shuffled = shuffle(anonymized);

  const participantNames = participants.map((p) => p.name);
  const statementsBlock = shuffled.map((s) => `[${s.label}]\n${s.text}`).join('\n\n---\n\n');

  const userMessage = `להלן רשימת המשתתפים בפגישה (רק השמות, בלי הקשר נוסף):
${participantNames.map((n) => `- ${n}`).join('\n')}

להלן אמירות מתוך שלב הדיון של הפגישה, בסדר מעורבב ובלי ציון מי אמר מה:

${statementsBlock}

המשימה שלך: לכל אמירה מסומנת, נחש איזה משתתף מהרשימה למעלה סביר שאמר אותה,
בהתבסס על התוכן, הסגנון, והאינטרסים שמשתקפים בה. לכל אמירה יש בדיוק דובר אחד
מתוך הרשימה. אתה חייב לשייך כל אמירה למישהו — גם אם אתה לא בטוח.`;

  console.log(
    `מריץ מדד נבדלות פרסונות על פגישה ${meetingId} (${discussionEntries.length} אמירות, ${participants.length} משתתפים)...`
  );

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('מפתח ANTHROPIC_API_KEY לא מוגדר בסביבה — נדרש כדי להריץ את המדד.');
    process.exitCode = 1;
    return;
  }

  const result = await callModel({
    model: MODELS.facilitator,
    system: [
      {
        type: 'text',
        text: 'אתה שופט שמנתח תמלילי דיון ומנסה לשייך אמירות אנונימיות לדוברים, בהתבסס על תוכן, סגנון ואינטרסים בלבד.',
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 8000,
    effort: 'high',
    jsonSchema: buildDistinctivenessSchema(participantNames),
  });

  if (result.refused) {
    console.error('המודל סירב לבצע את המשימה.');
    process.exitCode = 1;
    return;
  }

  const parsed = JSON.parse(result.text) as { assignments: Assignment[] };
  const report = computeDistinctivenessReport(shuffled, parsed.assignments, participantNames);
  console.log('\n' + renderReport(report));
  process.exitCode = report.passed ? 0 : 1;
}

const isMainModule = path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname);
if (isMainModule) {
  main().catch((err) => {
    console.error('שגיאה בהרצת המדד:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
