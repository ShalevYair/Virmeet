// Virmeet — dev-only speaker-attribution eval (docs/PLAN-correctness-and-evaluation.md §6).
//
// Reads a meeting JSON exported from the app's "ייצוא JSON" button (a
// completed meeting only), shuffles its discussion-phase lines with a seeded
// RNG, and asks a model to reattribute each line to a participant by name and
// role only (never persona.prompt/files/prep — see attribution.ts). Reports
// accuracy against chance (1/N participants) plus a per-persona and confusion
// breakdown. Deliberately outside src/app: a dev tool for judging whether a
// prompt change made personas sound more distinct, not a shipped feature.
//
// Usage: npm run eval:attribution -- <exported-meeting.json> [--seed=N]
// Requires ANTHROPIC_API_KEY and/or GEMINI_API_KEY in the environment.

import { readFileSync } from 'node:fs';
import { buildAttributionInput, runAttributionTest, scoreAttribution } from '../src/lib/eval/attribution';
import { getModelProvider, pickFacilitatorModel } from '../src/lib/types';
import type { Meeting } from '../src/lib/types';
import type { AttributionParticipant } from '../src/lib/eval/attribution';

interface ExportedMeetingFile {
  meeting: Meeting;
  participants: AttributionParticipant[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { filePath: string; seed: number } {
  const filePath = argv.find((a) => !a.startsWith('--'));
  if (!filePath) {
    fail('שימוש: npm run eval:attribution -- <path-to-exported-meeting.json> [--seed=N]');
  }
  const seedArg = argv.find((a) => a.startsWith('--seed='));
  const seed = seedArg ? Number(seedArg.slice('--seed='.length)) : 42;
  if (!Number.isFinite(seed)) fail(`ערך seed לא תקין: ${seedArg}`);
  return { filePath, seed };
}

async function main(): Promise<void> {
  const { filePath, seed } = parseArgs(process.argv.slice(2));

  let raw: ExportedMeetingFile;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    fail(`לא ניתן לקרוא את הקובץ: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw.meeting || !raw.participants) {
    fail('קובץ הקלט אינו קובץ ייצוא תקין של פגישה (חסר meeting/participants) — ייצא מחדש דרך "ייצוא JSON".');
  }
  if (raw.meeting.status !== 'completed') {
    fail(`הפגישה בקובץ במצב "${raw.meeting.status}", לא "completed" — אין תמליל דיון מלא לבדוק.`);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || undefined;
  const geminiKey = process.env.GEMINI_API_KEY || undefined;
  if (!anthropicKey && !geminiKey) {
    fail('יש להגדיר ANTHROPIC_API_KEY או GEMINI_API_KEY בסביבה כדי להריץ את מבחן הייחוס.');
  }

  const model = pickFacilitatorModel({ anthropic: anthropicKey, gemini: geminiKey });
  const apiKey = getModelProvider(model) === 'gemini' ? geminiKey : anthropicKey;

  const input = buildAttributionInput(raw.meeting.transcript, raw.participants, seed);
  if (input.items.length === 0) {
    fail('לא נמצאו שורות דיון של משתתפים בקובץ הזה — אין מה לבדוק.');
  }

  console.log(`מריץ מבחן ייחוס דוברים: ${input.items.length} אמירות, seed=${seed}, מודל שופט: ${model}`);
  const guesses = await runAttributionTest(input, raw.participants, { model, apiKey });
  const score = scoreAttribution(input.truth, guesses, raw.participants);

  console.log('');
  console.log(
    `דיוק: ${(score.accuracy * 100).toFixed(1)}% (${score.correct}/${score.total}) — רמת ניחוש אקראי: ${(
      score.chance * 100
    ).toFixed(1)}%`
  );
  console.log('לפי משתתף:');
  for (const p of score.perPersona) {
    console.log(`  ${p.name}: recall=${(p.recall * 100).toFixed(1)}%, precision=${(p.precision * 100).toFixed(1)}%`);
  }
  console.log('');
  console.log('מטריצת בלבול (אמת -> ניחוש -> כמות):');
  console.log(JSON.stringify(score.confusion, null, 2));
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
