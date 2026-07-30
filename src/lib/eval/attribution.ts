// Virmeet — speaker-attribution eval (docs/PLAN-correctness-and-evaluation.md §6).
//
// The README states the tool's own bar for success: shuffle a completed
// meeting's discussion lines, ask a different model to reattribute each one
// to a participant, and compare against chance. This module is the pure/
// testable core of that check; scripts/eval-attribution.ts is the CLI that
// drives it against an exported meeting (see docs §6.2/§7.2 — this stays a
// dev tool, outside the shipped app bundle).
//
// Not part of docs/PLAN-file-context-optimization.md's territory: nothing
// here touches file/context caching.

import type { TranscriptEntry } from '../types';
import { callModel } from '../llm';

/** Just enough persona data for the judge — never `prompt`, files, or anything from `prep`. */
export interface AttributionParticipant {
  id: string;
  name: string;
  role: string;
}

export interface AttributionItem {
  index: number;
  text: string;
}

export interface AttributionInput {
  items: AttributionItem[];
  /** index -> the participant name that actually said it. */
  truth: Map<number, string>;
}

export interface AttributionGuess {
  index: number;
  personaName: string;
}

export const ATTRIBUTION_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      description: 'שיוך של כל אינדקס לשם המשתתף שלדעתך אמר את האמירה הזו — בדיוק פעם אחת לכל אינדקס.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'מספר האינדקס של האמירה.' },
          personaName: { type: 'string', description: 'שם המשתתף שלדעתך אמר את האמירה.' },
        },
        required: ['index', 'personaName'],
        additionalProperties: false,
      },
    },
  },
  required: ['assignments'],
  additionalProperties: false,
} as const;

/** Deterministic PRNG (mulberry32) — same seed always produces the same shuffle, so runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Filters `transcript` down to discussion-phase lines spoken by an actual
 * participant (never 'system' or 'facilitator'), then shuffles them with a
 * seeded RNG so a given (transcript, participants, seed) triple always
 * produces the same shuffle — runs are reproducible and diffable across
 * prompt changes.
 */
export function buildAttributionInput(
  transcript: TranscriptEntry[],
  participants: AttributionParticipant[],
  seed: number
): AttributionInput {
  const nameById = new Map(participants.map((p) => [p.id, p.name]));
  const discussionLines = transcript.filter(
    (entry) => entry.phase === 'discussion' && nameById.has(entry.speakerId)
  );
  const shuffled = seededShuffle(discussionLines, seed);

  const items: AttributionItem[] = [];
  const truth = new Map<number, string>();
  shuffled.forEach((entry, index) => {
    items.push({ index, text: entry.text });
    truth.set(index, nameById.get(entry.speakerId) as string);
  });

  return { items, truth };
}

function buildAttributionPrompt(items: AttributionItem[], participants: AttributionParticipant[]): string {
  const participantsList = participants.map((p) => `- ${p.name} (${p.role})`).join('\n');
  const itemsList = items.map((item) => `[${item.index}] ${item.text}`).join('\n\n');
  return (
    `להלן רשימת המשתתפים בפגישה — שם ותפקיד בלבד, ללא מידע נוסף עליהם:\n${participantsList}\n\n` +
    `להלן אמירות מתוך שלב הדיון של הפגישה, מעורבבות וממוספרות. עבור כל אמירה, שייך אותה ` +
    `לאחד המשתתפים לפי מי שלדעתך אמר אותה — בהתבסס אך ורק על תוכן האמירה עצמה:\n\n${itemsList}\n\n` +
    `החזר שיוך לכל אינדקס, בדיוק פעם אחת לכל אינדקס.`
  );
}

/**
 * Runs the attribution test as a single model call through llm.ts#callModel
 * (works against whichever provider `opts.model` belongs to). The judge only
 * ever sees participant names/roles and the shuffled item text — never
 * `persona.prompt`, private files, or the `prep` phase, which would let the
 * judge match prompt-to-output instead of actually discriminating voices.
 */
export async function runAttributionTest(
  input: AttributionInput,
  participants: AttributionParticipant[],
  opts: { model: string; apiKey?: string }
): Promise<AttributionGuess[]> {
  const result = await callModel({
    model: opts.model,
    system: [
      {
        type: 'text',
        text: 'אתה שופט שמנסה לזהות מי מהמשתתפים אמר כל אמירה נתונה, בהתבסס רק על תוכן האמירה עצמה.',
      },
    ],
    messages: [{ role: 'user', content: buildAttributionPrompt(input.items, participants) }],
    maxTokens: 8000,
    effort: 'high',
    jsonSchema: ATTRIBUTION_SCHEMA,
    apiKey: opts.apiKey,
  });

  if (result.refused) {
    throw new Error('מבחן הייחוס נכשל: המודל השופט סירב לענות.');
  }
  if (result.truncated) {
    throw new Error('מבחן הייחוס נכשל: תשובת המודל השופט נקטעה בשל מגבלת אורך.');
  }

  const parsed = JSON.parse(result.text) as { assignments: AttributionGuess[] };
  return parsed.assignments;
}

export interface AttributionScore {
  total: number;
  correct: number;
  accuracy: number;
  /** 1/N — the accuracy a uniform random guesser would get with N participants. */
  chance: number;
  perPersona: { name: string; recall: number; precision: number }[];
  /** truthName -> guessName -> count. */
  confusion: Record<string, Record<string, number>>;
}

/** Pure scoring: no I/O, no model calls — safe to unit test directly against hand-built guesses. */
export function scoreAttribution(
  truth: Map<number, string>,
  guesses: AttributionGuess[],
  participants: AttributionParticipant[]
): AttributionScore {
  const guessByIndex = new Map(guesses.map((g) => [g.index, g.personaName]));
  const confusion: Record<string, Record<string, number>> = {};
  const truthCounts = new Map<string, number>();
  const guessedCounts = new Map<string, number>();
  const correctCounts = new Map<string, number>();

  let correct = 0;
  for (const [index, truthName] of truth) {
    const guessName = guessByIndex.get(index) ?? '(ללא תשובה)';
    truthCounts.set(truthName, (truthCounts.get(truthName) ?? 0) + 1);
    guessedCounts.set(guessName, (guessedCounts.get(guessName) ?? 0) + 1);
    confusion[truthName] = confusion[truthName] ?? {};
    confusion[truthName][guessName] = (confusion[truthName][guessName] ?? 0) + 1;
    if (guessName === truthName) {
      correct += 1;
      correctCounts.set(truthName, (correctCounts.get(truthName) ?? 0) + 1);
    }
  }

  const perPersona = participants.map((p) => {
    const truthCount = truthCounts.get(p.name) ?? 0;
    const guessedCount = guessedCounts.get(p.name) ?? 0;
    const correctCount = correctCounts.get(p.name) ?? 0;
    return {
      name: p.name,
      recall: truthCount > 0 ? correctCount / truthCount : 0,
      precision: guessedCount > 0 ? correctCount / guessedCount : 0,
    };
  });

  return {
    total: truth.size,
    correct,
    accuracy: truth.size > 0 ? correct / truth.size : 0,
    chance: participants.length > 0 ? 1 / participants.length : 0,
    perPersona,
    confusion,
  };
}
