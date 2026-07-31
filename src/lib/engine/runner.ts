// Virmeet — meeting state machine (spec §4).
//
// Deterministic phases: prep -> opening -> discussion (N rounds) -> convergence
// -> extraction. The LLM only ever acts *inside* a phase; there is no
// free-form round-robin. See prompts.ts for the Hebrew prompt text and
// schemas.ts for the structured-output JSON schemas.

import { randomUUID } from 'crypto';
import {
  Meeting,
  MeetingResult,
  MeetingType,
  OrgSettings,
  Persona,
  TranscriptEntry,
} from '../types';
import { MODELS } from '../types';
import { callModel as realCallModel, CallModelMessage, CallModelResult, CallModelUsage } from '../anthropic';
import {
  getMeeting as storeGetMeeting,
  getOrgSettings as storeGetOrgSettings,
  listMeetingTypes as storeListMeetingTypes,
  listPersonas as storeListPersonas,
  updateMeeting as storeUpdateMeeting,
} from '../store';
import { estimateCallCostUsd } from '../pricing';
import { CallBudget } from './budget';
import * as prompts from './prompts';
import { EXTRACTION_SCHEMA, ExtractionModelOutput, OPENING_SCHEMA, PREP_SCHEMA } from './schemas';
import { CallModelFn, CallUsageWithCost, OnEvent, OpeningOutput, PhaseName, PrepOutput, RunMeetingDeps } from './types';

const defaultDeps: RunMeetingDeps = {
  callModel: realCallModel,
  updateMeeting: storeUpdateMeeting,
  getMeeting: storeGetMeeting,
  getPersonas: storeListPersonas,
  getMeetingTypes: storeListMeetingTypes,
  getOrgSettings: storeGetOrgSettings,
};

const REGULAR_MAX_TOKENS = 8000;
// Extraction's output is a large structured MeetingResult (summary, decisions,
// openQuestions, conflicts, risks, tasks with assumptions, modelAssumptions),
// and thinking tokens count against max_tokens too — 8000 can be exhausted by
// thinking alone before any JSON is written (A4 in WORKPLAN.md). This also
// pushes the call past STREAMING_THRESHOLD in anthropic.ts, which is correct:
// a non-streaming call with max_tokens this high risks an HTTP timeout.
const EXTRACTION_MAX_TOKENS = 32000;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function makeEntry(
  phase: PhaseName,
  speakerId: string,
  speakerName: string,
  text: string,
  extra: Partial<Pick<TranscriptEntry, 'round' | 'webSearches' | 'usage'>> = {}
): TranscriptEntry {
  return {
    id: randomUUID(),
    phase,
    speakerId,
    speakerName,
    text,
    createdAt: nowIso(),
    ...extra,
  };
}

/** [headerBlock (cached), rest] — see the `headerBlock`/`userMessage` note inside runMeeting. */
function cachedUserMessage(headerBlock: string, rest: string): CallModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: headerBlock, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: rest },
    ],
  };
}

export type ExtractionOutcome =
  | { ok: true; result: MeetingResult; usage: CallModelUsage }
  | { ok: false; error: string; usage: CallModelUsage };

/**
 * Phase 4 (extraction) in isolation: turns an existing transcript + convergence
 * summary into the structured MeetingResult, without touching prep/opening/
 * discussion/convergence. Shared by runMeeting() below and by POST
 * /api/meetings/[id]/extract (A3 in WORKPLAN.md), which reruns just this phase
 * for a meeting that failed after its transcript was already saved — so a
 * pricey discussion never has to be redone because extraction alone failed.
 */
export async function runExtraction(
  meeting: Meeting,
  meetingTypes: MeetingType[],
  org: OrgSettings,
  participants: Persona[],
  transcript: TranscriptEntry[],
  convergenceSummary: string,
  apiKey: string | undefined,
  callModel: CallModelFn = realCallModel
): Promise<ExtractionOutcome> {
  const headerBlock = prompts.meetingHeaderBlock(meeting, meetingTypes);
  const result = await callModel({
    model: MODELS.facilitator,
    system: prompts.buildFacilitatorSystemBlocks(org),
    messages: [
      cachedUserMessage(headerBlock, prompts.buildExtractionUserMessage(participants, transcript, convergenceSummary)),
    ],
    maxTokens: EXTRACTION_MAX_TOKENS,
    effort: 'high',
    jsonSchema: EXTRACTION_SCHEMA,
    apiKey,
  });

  if (result.refused) {
    return {
      ok: false,
      error: 'המנחה סירב לספק את חילוץ המשימות והתוצאות של הפגישה.',
      usage: result.usage,
    };
  }
  if (result.stopReason === 'max_tokens') {
    return {
      ok: false,
      error: 'פלט החילוץ נקטע באמצע — הפגישה ארוכה מדי למגבלת הטוקנים הנוכחית.',
      usage: result.usage,
    };
  }

  let raw: ExtractionModelOutput;
  try {
    raw = JSON.parse(result.text) as ExtractionModelOutput;
  } catch {
    return { ok: false, error: 'פלט החילוץ אינו JSON תקין.', usage: result.usage };
  }

  const personaIdByName = new Map(participants.map((p) => [p.name, p.id]));
  const finalResult: MeetingResult = {
    summary: raw.summary,
    decisions: raw.decisions,
    openQuestions: raw.openQuestions,
    conflicts: raw.conflicts,
    risks: raw.risks,
    modelAssumptions: raw.modelAssumptions,
    tasks: raw.tasks.map((t) => ({
      id: randomUUID(),
      title: t.title,
      description: t.description,
      ownerPersonaId: personaIdByName.get(t.ownerName) ?? null,
      ownerName: t.ownerName,
      priority: t.priority,
      dependsOn: t.dependsOn,
      assumption: t.assumption,
      riskIfAssumptionWrong: t.riskIfAssumptionWrong,
    })),
  };

  return { ok: true, result: finalResult, usage: result.usage };
}

/**
 * Runs a meeting end-to-end through all five phases, streaming events via
 * `onEvent` and persisting to disk after every phase transition and every
 * transcript entry. Never rejects: unexpected failures are reported through
 * `onEvent({type:'error', ...})` and, where applicable, by marking the
 * meeting `status:'failed'` — callers (the SSE route) just drain events until
 * this promise settles.
 *
 * `overrideDeps` exists purely for tests: production callers should invoke
 * `runMeeting(meetingId, onEvent)` and let it use the real store + Anthropic
 * client.
 *
 * `apiKey` — when the run route received one from the browser's
 * x-anthropic-api-key header — is forwarded to every model call below and
 * nowhere else: it is never added to `meeting`, `transcript`, or any
 * persisted patch, so it can't reach data/ or the exported transcript.
 */
export async function runMeeting(
  meetingId: string,
  onEvent: OnEvent,
  overrideDeps: Partial<RunMeetingDeps> = {},
  apiKey?: string
): Promise<void> {
  const deps: RunMeetingDeps = { ...defaultDeps, ...overrideDeps };

  const meeting = await deps.getMeeting(meetingId);
  if (!meeting) {
    onEvent({ type: 'error', message: 'הפגישה לא נמצאה.' });
    return;
  }

  const allPersonas = await deps.getPersonas();
  const personaById = new Map(allPersonas.map((p) => [p.id, p]));
  const participants = meeting.participantIds
    .map((id) => personaById.get(id))
    .filter((p): p is Persona => p != null);

  if (participants.length < 2) {
    onEvent({ type: 'error', message: 'נדרשים לפחות שני משתתפים כדי להריץ את הפגישה.' });
    return;
  }

  const allMeetingTypes = await deps.getMeetingTypes();
  const meetingTypeById = new Map(allMeetingTypes.map((t) => [t.id, t]));
  const meetingTypes = meeting.meetingTypeIds
    .map((id) => meetingTypeById.get(id))
    .filter((t): t is MeetingType => t != null);

  const org: OrgSettings = await deps.getOrgSettings();

  // Identical byte-for-byte across every call below (A1 in WORKPLAN.md): sent
  // as its own leading content block with cache_control so the cached prefix
  // extends past the system blocks to cover meeting.files too, instead of
  // re-sending shared background files uncached on every single call.
  const headerBlock = prompts.meetingHeaderBlock(meeting, meetingTypes);
  function userMessage(rest: string): CallModelMessage {
    return cachedUserMessage(headerBlock, rest);
  }

  // Mutable run state. `meeting` above stays a read-only snapshot of the
  // fields that don't change during a run (title/objective/files/rounds) —
  // everything that *does* change lives in these locals.
  let transcript: TranscriptEntry[] = [...meeting.transcript];
  let usage = { ...meeting.usage };

  const budget = new CallBudget(new Map(participants.map((p) => [p.id, p.maxApiCalls])));

  async function persist(patch: Partial<Meeting> = {}): Promise<void> {
    await deps.updateMeeting(meetingId, { transcript, usage, ...patch });
  }

  async function emitEntry(entry: TranscriptEntry): Promise<void> {
    transcript = [...transcript, entry];
    onEvent({ type: 'entry', entry });
    await persist();
  }

  async function emitPhase(phase: PhaseName): Promise<void> {
    onEvent({ type: 'phase', phase });
    // Deliberately does NOT patch `status`: it's set once, up front, before
    // phase 0 starts. Writing 'running' here on every phase transition used
    // to clobber a 'cancelled' status set concurrently by the user's cancel
    // request (A2 in WORKPLAN.md).
    await persist();
  }

  /**
   * Polled between phases and between discussion turns. If the user's cancel
   * request has landed (status flipped to 'cancelled' by the PATCH the UI
   * sends), logs it and stops the run — the transcript accumulated so far has
   * already been persisted throughout.
   */
  async function checkCancelled(phase: PhaseName): Promise<boolean> {
    const current = await deps.getMeeting(meetingId);
    if (current?.status !== 'cancelled') return false;
    await emitEntry(makeEntry(phase, 'system', 'מערכת', 'הפגישה בוטלה על ידי המשתמש.'));
    onEvent({ type: 'error', message: 'הפגישה בוטלה על ידי המשתמש.' });
    return true;
  }

  function recordApiCall(): void {
    usage = { ...usage, apiCalls: usage.apiCalls + 1 };
  }

  /** Accumulates one call's tokens into the running meeting total and returns its estimated cost. */
  function recordUsage(model: string, u: CallModelResult['usage']): CallUsageWithCost {
    const costUsd = estimateCallCostUsd(model, u);
    usage = {
      ...usage,
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens + u.cacheCreationTokens,
      costUsd: usage.costUsd + costUsd,
    };
    return { ...u, costUsd };
  }

  await persist({ status: 'running', error: null });

  // -------------------------------------------------------------------
  // Phase 0 — prep (parallel, no visibility into other personas' output)
  // -------------------------------------------------------------------
  await emitPhase('prep');
  if (await checkCancelled('prep')) return;
  const prepResults = new Map<string, PrepOutput>();

  const prepAttempts = await Promise.allSettled(
    participants.map(async (persona) => {
      recordApiCall();
      try {
        const result = await deps.callModel({
          model: persona.model,
          system: prompts.buildPersonaSystemBlocks(org, persona),
          messages: [userMessage(prompts.buildPrepUserMessage())],
          maxTokens: REGULAR_MAX_TOKENS,
          effort: 'medium',
          jsonSchema: PREP_SCHEMA,
          webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
          apiKey,
        });
        return result;
      } finally {
        budget.record(persona.id);
      }
    })
  );

  // Process in participant order (not settle order) so the transcript reads
  // deterministically even though the calls above ran concurrently.
  for (let i = 0; i < participants.length; i++) {
    const persona = participants[i];
    const attempt = prepAttempts[i];

    if (attempt.status === 'rejected') {
      await emitEntry(
        makeEntry('prep', 'system', 'מערכת', prompts.personaErrorLine(persona.name, errorMessage(attempt.reason)))
      );
      continue;
    }

    const result = attempt.value;
    const usageWithCost = recordUsage(persona.model, result.usage);

    if (result.refused) {
      await emitEntry(makeEntry('prep', 'system', 'מערכת', prompts.personaRefusedLine(persona.name)));
      continue;
    }

    let parsed: PrepOutput;
    try {
      parsed = JSON.parse(result.text) as PrepOutput;
    } catch {
      await emitEntry(
        makeEntry('prep', 'system', 'מערכת', prompts.personaErrorLine(persona.name, 'פלט לא תקין (JSON) מהמודל'))
      );
      continue;
    }

    prepResults.set(persona.id, parsed);
    const text = `הבנה: ${parsed.understanding}\n\nחששות:\n${parsed.concerns
      .map((c) => `- ${c}`)
      .join('\n')}\n\nשאלות:\n${parsed.questions.map((q) => `- ${q}`).join('\n')}`;
    await emitEntry(
      makeEntry('prep', persona.id, persona.name, text, {
        webSearches: result.webSearches.length ? result.webSearches : undefined,
        usage: usageWithCost,
      })
    );
  }

  // -------------------------------------------------------------------
  // Phase 1 — opening (facilitator, single call)
  // -------------------------------------------------------------------
  await emitPhase('opening');
  if (await checkCancelled('opening')) return;
  let opening: OpeningOutput = { framing: '', conflicts: [] };
  {
    recordApiCall();
    try {
      const result = await deps.callModel({
        model: MODELS.facilitator,
        system: prompts.buildFacilitatorSystemBlocks(org),
        messages: [userMessage(prompts.buildOpeningUserMessage(participants, prepResults))],
        maxTokens: REGULAR_MAX_TOKENS,
        effort: 'high',
        jsonSchema: OPENING_SCHEMA,
        apiKey,
      });
      const usageWithCost = recordUsage(MODELS.facilitator, result.usage);

      if (result.refused) {
        opening = {
          framing: 'לא התקבל מסגור מהמנחה בשלב הפתיחה — יש להתייחס לתמליל ההכנה של המשתתפים בלבד.',
          conflicts: [],
        };
        await emitEntry(
          makeEntry('opening', 'system', 'מערכת', 'המנחה סירב לספק מסגור לפגישה. ממשיכים עם מסגור בסיסי.')
        );
      } else {
        opening = JSON.parse(result.text) as OpeningOutput;
        const conflictsText = opening.conflicts
          .map((c, i) => `${i + 1}. ${c.topic} — ${c.sides} (חלוקים: ${c.whoDisagrees.join(', ')})`)
          .join('\n');
        await emitEntry(
          makeEntry(
            'opening',
            'facilitator',
            'מנחה',
            `${opening.framing}\n\nהתנגשויות שזוהו:\n${conflictsText || '(לא זוהו התנגשויות ממוקדות)'}`,
            { usage: usageWithCost }
          )
        );
      }
    } catch (err) {
      opening = {
        framing: 'שלב הפתיחה נכשל — הדיון ימשיך ללא מסגור מהמנחה, ישירות מתוך שלב ההכנה.',
        conflicts: [],
      };
      await emitEntry(
        makeEntry(
          'opening',
          'system',
          'מערכת',
          `שלב הפתיחה נכשל (${errorMessage(err)}). ממשיכים לדיון עם מסגור בסיסי.`
        )
      );
    }
  }

  // -------------------------------------------------------------------
  // Phase 2 — discussion (N rounds, sequential turns)
  // -------------------------------------------------------------------
  await emitPhase('discussion');
  if (await checkCancelled('discussion')) return;
  const totalRounds = meeting.discussionRounds;

  for (let round = 1; round <= totalRounds; round++) {
    for (const persona of participants) {
      if (await checkCancelled('discussion')) return;
      if (!budget.canCall(persona.id)) {
        if (budget.shouldAnnounceExhausted(persona.id)) {
          await emitEntry(
            makeEntry('discussion', 'system', 'מערכת', prompts.budgetExhaustedLine(persona.name), { round })
          );
        }
        continue;
      }

      recordApiCall();
      try {
        const result = await deps.callModel({
          model: persona.model,
          system: prompts.buildPersonaSystemBlocks(org, persona),
          messages: [
            userMessage(prompts.buildDiscussionUserMessage(persona, round, totalRounds, opening, transcript)),
          ],
          maxTokens: REGULAR_MAX_TOKENS,
          effort: 'medium',
          webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
          apiKey,
        });
        budget.record(persona.id);
        const usageWithCost = recordUsage(persona.model, result.usage);

        if (result.refused) {
          await emitEntry(
            makeEntry('discussion', 'system', 'מערכת', prompts.personaRefusedLine(persona.name), { round })
          );
          continue;
        }

        await emitEntry(
          makeEntry('discussion', persona.id, persona.name, result.text, {
            round,
            webSearches: result.webSearches.length ? result.webSearches : undefined,
            usage: usageWithCost,
          })
        );
      } catch (err) {
        budget.record(persona.id);
        await emitEntry(
          makeEntry('discussion', 'system', 'מערכת', prompts.personaErrorLine(persona.name, errorMessage(err)), {
            round,
          })
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // Phase 3 — convergence (facilitator, single call)
  // -------------------------------------------------------------------
  await emitPhase('convergence');
  if (await checkCancelled('convergence')) return;
  let convergenceSummary = '';
  {
    recordApiCall();
    try {
      const result = await deps.callModel({
        model: MODELS.facilitator,
        system: prompts.buildFacilitatorSystemBlocks(org),
        messages: [userMessage(prompts.buildConvergenceUserMessage(transcript))],
        maxTokens: REGULAR_MAX_TOKENS,
        effort: 'high',
        apiKey,
      });
      const usageWithCost = recordUsage(MODELS.facilitator, result.usage);

      if (result.refused) {
        convergenceSummary = '(המנחה סירב לספק סיכום התכנסות; יש להתבסס על התמליל המלא בלבד.)';
        await emitEntry(makeEntry('convergence', 'system', 'מערכת', 'המנחה סירב לספק סיכום התכנסות.'));
      } else {
        convergenceSummary = result.text;
        await emitEntry(makeEntry('convergence', 'facilitator', 'מנחה', result.text, { usage: usageWithCost }));
      }
    } catch (err) {
      convergenceSummary = '(שלב ההתכנסות נכשל; יש להתבסס על התמליל המלא בלבד.)';
      await emitEntry(
        makeEntry(
          'convergence',
          'system',
          'מערכת',
          `שלב ההתכנסות נכשל (${errorMessage(err)}). ממשיכים לחילוץ המשימות ישירות מהתמליל.`
        )
      );
    }
  }

  // -------------------------------------------------------------------
  // Phase 4 — extraction (facilitator, single call, structured output)
  // A failure here — and only here — marks the meeting `status:'failed'`.
  // The transcript accumulated above has already been persisted throughout.
  // -------------------------------------------------------------------
  await emitPhase('extraction');
  if (await checkCancelled('extraction')) return;
  try {
    recordApiCall();
    const outcome = await runExtraction(
      meeting,
      meetingTypes,
      org,
      participants,
      transcript,
      convergenceSummary,
      apiKey,
      deps.callModel
    );
    const usageWithCost = recordUsage(MODELS.facilitator, outcome.usage);

    if (!outcome.ok) {
      throw new Error(outcome.error);
    }

    await persist({ status: 'completed', result: outcome.result, completedAt: nowIso(), error: null });
    onEvent({ type: 'done', result: outcome.result, usage: usageWithCost });
  } catch (err) {
    const message = errorMessage(err);
    await persist({ status: 'failed', error: message });
    onEvent({ type: 'error', message });
  }
}
