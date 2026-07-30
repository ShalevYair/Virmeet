// Virmeet — meeting state machine (spec §4).
//
// Deterministic phases: prep -> opening -> discussion (N rounds) -> convergence
// -> extraction. The LLM only ever acts *inside* a phase; there is no
// free-form round-robin. See prompts.ts for the Hebrew prompt text and
// schemas.ts for the structured-output JSON schemas.

import {
  Meeting,
  MeetingResult,
  MeetingType,
  OrgSettings,
  Persona,
  TranscriptEntry,
} from '../types';
import { getModelProvider, pickFacilitatorModel } from '../types';
import { callModel as realCallModel } from '../llm';
import { CallModelResult } from '../llm-types';
import {
  getMeeting as storeGetMeeting,
  getOrgSettings as storeGetOrgSettings,
  listMeetingTypes as storeListMeetingTypes,
  listPersonas as storeListPersonas,
  updateMeeting as storeUpdateMeeting,
} from '../store';
import { CallBudget } from './budget';
import * as prompts from './prompts';
import { EXTRACTION_SCHEMA, ExtractionModelOutput, OPENING_SCHEMA, PREP_SCHEMA } from './schemas';
import { OnEvent, OpeningOutput, PhaseName, PrepOutput, RunMeetingDeps } from './types';

const defaultDeps: RunMeetingDeps = {
  callModel: realCallModel,
  updateMeeting: storeUpdateMeeting,
  getMeeting: storeGetMeeting,
  getPersonas: storeListPersonas,
  getMeetingTypes: storeListMeetingTypes,
  getOrgSettings: storeGetOrgSettings,
};

const REGULAR_MAX_TOKENS = 8000;

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
    id: crypto.randomUUID(),
    phase,
    speakerId,
    speakerName,
    text,
    createdAt: nowIso(),
    ...extra,
  };
}

/**
 * Runs a meeting end-to-end through all five phases, streaming events via
 * `onEvent` and persisting to IndexedDB after every phase transition and
 * every transcript entry. Never rejects: unexpected failures are reported
 * through `onEvent({type:'error', ...})` and, where applicable, by marking
 * the meeting `status:'failed'` — callers just drain events until this
 * promise settles.
 *
 * `overrideDeps` exists purely for tests: production callers should invoke
 * `runMeeting(meetingId, onEvent)` and let it use the real store + the
 * Anthropic/Gemini clients (see ../llm.ts).
 *
 * `apiKeys` — personal keys read out of localStorage in the browser (see
 * api-key.ts) — are forwarded to every model call below (whichever key
 * matches that call's model provider) and nowhere else: they are never added
 * to `meeting`, `transcript`, or any persisted patch, so they can't reach
 * IndexedDB or the exported transcript.
 *
 * `signal` — when aborted, the run stops at the next checkpoint (see
 * `abortIfCancelled`) instead of running to completion in the background.
 * The meeting is marked `status:'cancelled'`; the transcript and usage
 * accumulated so far are preserved.
 */
export async function runMeeting(
  meetingId: string,
  onEvent: OnEvent,
  overrideDeps: Partial<RunMeetingDeps> = {},
  apiKeys: { anthropic?: string; gemini?: string } = {},
  signal?: AbortSignal
): Promise<void> {
  const deps: RunMeetingDeps = { ...defaultDeps, ...overrideDeps };

  /** The personal key (if any) matching `model`'s provider — Anthropic vs Gemini. */
  function apiKeyFor(model: string): string | undefined {
    return getModelProvider(model) === 'gemini' ? apiKeys.gemini : apiKeys.anthropic;
  }

  function isAborted(): boolean {
    return signal?.aborted === true;
  }

  // The facilitator doesn't have to run on Anthropic — a meeting where every
  // key is Gemini-only should still complete end to end (see pickFacilitatorModel).
  const facilitatorModel = pickFacilitatorModel(apiKeys);

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

  // Mutable run state. `meeting` above stays a read-only snapshot of the
  // fields that don't change during a run (title/objective/files/rounds) —
  // everything that *does* change lives in these locals.
  let transcript: TranscriptEntry[] = [...meeting.transcript];
  let usage = { ...meeting.usage };

  const budget = new CallBudget(new Map(participants.map((p) => [p.id, p.maxApiCalls])));

  async function persist(patch: Partial<Meeting> = {}): Promise<void> {
    const fullPatch: Partial<Meeting> = { transcript, usage, ...patch };
    // A cancelled run must never have a later write resurrect it as
    // 'running' or 'completed' — transcript/usage still get through, so
    // whatever was already said (and already paid for) is preserved.
    if (isAborted()) {
      delete fullPatch.status;
      delete fullPatch.completedAt;
    }
    await deps.updateMeeting(meetingId, fullPatch);
  }

  async function emitEntry(entry: TranscriptEntry): Promise<void> {
    transcript = [...transcript, entry];
    onEvent({ type: 'entry', entry });
    await persist();
  }

  async function emitPhase(phase: PhaseName): Promise<void> {
    onEvent({ type: 'phase', phase });
    await persist({ status: 'running' });
  }

  /**
   * Checkpoint called at every point the run could safely stop. Returns
   * `true` (after logging a system line, marking the meeting `cancelled`,
   * and emitting `{type:'cancelled'}`) iff `signal` was aborted — callers
   * must `return` immediately when it does.
   */
  async function abortIfCancelled(phase: PhaseName, round?: number): Promise<boolean> {
    if (!isAborted()) return false;
    await emitEntry(
      makeEntry(phase, 'system', 'מערכת', 'הפגישה בוטלה על ידי המשתמש. הדיון נעצר.', round !== undefined ? { round } : {})
    );
    await deps.updateMeeting(meetingId, { status: 'cancelled' });
    onEvent({ type: 'cancelled' });
    return true;
  }

  function recordApiCall(): void {
    usage = { ...usage, apiCalls: usage.apiCalls + 1 };
  }

  function recordTokens(u: CallModelResult['usage']): void {
    usage = {
      ...usage,
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
    };
  }

  if (await abortIfCancelled('prep')) return;
  await persist({ status: 'running', error: null });

  // -------------------------------------------------------------------
  // Phase 0 — prep (parallel, no visibility into other personas' output)
  // -------------------------------------------------------------------
  if (await abortIfCancelled('prep')) return;
  await emitPhase('prep');
  const prepResults = new Map<string, PrepOutput>();

  const prepAttempts = await Promise.allSettled(
    participants.map(async (persona) => {
      recordApiCall();
      try {
        const result = await deps.callModel({
          model: persona.model,
          system: prompts.buildPersonaSystemBlocks(org, persona, meeting),
          messages: [{ role: 'user', content: prompts.buildPrepUserMessage(meeting, meetingTypes) }],
          maxTokens: REGULAR_MAX_TOKENS,
          effort: 'medium',
          jsonSchema: PREP_SCHEMA,
          webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
          apiKey: apiKeyFor(persona.model),
        });
        return result;
      } finally {
        budget.record(persona.id);
      }
    })
  );

  if (await abortIfCancelled('prep')) return;

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
    recordTokens(result.usage);

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
        usage: result.usage,
      })
    );
  }

  // -------------------------------------------------------------------
  // Phase 1 — opening (facilitator, single call)
  // -------------------------------------------------------------------
  if (await abortIfCancelled('opening')) return;
  await emitPhase('opening');
  let opening: OpeningOutput = { framing: '', conflicts: [] };
  {
    recordApiCall();
    try {
      const result = await deps.callModel({
        model: facilitatorModel,
        system: prompts.buildFacilitatorSystemBlocks(org, meeting),
        messages: [
          {
            role: 'user',
            content: prompts.buildOpeningUserMessage(meeting, meetingTypes, participants, prepResults),
          },
        ],
        maxTokens: REGULAR_MAX_TOKENS,
        effort: 'high',
        jsonSchema: OPENING_SCHEMA,
        apiKey: apiKeyFor(facilitatorModel),
      });
      recordTokens(result.usage);

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
            `${opening.framing}\n\nהתנגשויות שזוהו:\n${conflictsText || '(לא זוהו התנגשויות ממוקדות)'}`
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
  if (await abortIfCancelled('discussion')) return;
  await emitPhase('discussion');
  const totalRounds = meeting.discussionRounds;

  for (let round = 1; round <= totalRounds; round++) {
    for (const persona of participants) {
      if (await abortIfCancelled('discussion', round)) return;
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
          system: prompts.buildPersonaSystemBlocks(org, persona, meeting),
          messages: [
            {
              role: 'user',
              content: prompts.buildDiscussionUserMessage(
                meeting,
                meetingTypes,
                persona,
                round,
                totalRounds,
                opening,
                transcript
              ),
            },
          ],
          maxTokens: REGULAR_MAX_TOKENS,
          effort: 'medium',
          webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
          apiKey: apiKeyFor(persona.model),
        });
        budget.record(persona.id);
        recordTokens(result.usage);

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
            usage: result.usage,
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
  if (await abortIfCancelled('convergence')) return;
  await emitPhase('convergence');
  let convergenceSummary = '';
  {
    recordApiCall();
    try {
      const result = await deps.callModel({
        model: facilitatorModel,
        system: prompts.buildFacilitatorSystemBlocks(org, meeting),
        messages: [
          { role: 'user', content: prompts.buildConvergenceUserMessage(meeting, meetingTypes, transcript) },
        ],
        maxTokens: REGULAR_MAX_TOKENS,
        effort: 'high',
        apiKey: apiKeyFor(facilitatorModel),
      });
      recordTokens(result.usage);

      if (result.refused) {
        convergenceSummary = '(המנחה סירב לספק סיכום התכנסות; יש להתבסס על התמליל המלא בלבד.)';
        await emitEntry(makeEntry('convergence', 'system', 'מערכת', 'המנחה סירב לספק סיכום התכנסות.'));
      } else {
        convergenceSummary = result.text;
        await emitEntry(makeEntry('convergence', 'facilitator', 'מנחה', result.text));
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
  if (await abortIfCancelled('extraction')) return;
  await emitPhase('extraction');
  try {
    recordApiCall();
    const result = await deps.callModel({
      model: facilitatorModel,
      system: prompts.buildFacilitatorSystemBlocks(org, meeting),
      messages: [
        {
          role: 'user',
          content: prompts.buildExtractionUserMessage(meeting, meetingTypes, participants, transcript, convergenceSummary),
        },
      ],
      maxTokens: REGULAR_MAX_TOKENS,
      effort: 'high',
      jsonSchema: EXTRACTION_SCHEMA,
      apiKey: apiKeyFor(facilitatorModel),
    });
    recordTokens(result.usage);

    if (result.refused) {
      throw new Error('המנחה סירב לספק את חילוץ המשימות והתוצאות של הפגישה.');
    }

    const raw = JSON.parse(result.text) as ExtractionModelOutput;
    const personaIdByName = new Map(participants.map((p) => [p.name, p.id]));

    const finalResult: MeetingResult = {
      summary: raw.summary,
      decisions: raw.decisions,
      openQuestions: raw.openQuestions,
      conflicts: raw.conflicts,
      risks: raw.risks,
      modelAssumptions: raw.modelAssumptions,
      tasks: raw.tasks.map((t) => ({
        id: crypto.randomUUID(),
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

    await persist({ status: 'completed', result: finalResult, completedAt: nowIso(), error: null });
    onEvent({ type: 'done', result: finalResult });
  } catch (err) {
    const message = errorMessage(err);
    await persist({ status: 'failed', error: message });
    onEvent({ type: 'error', message });
  }
}
