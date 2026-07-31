// Virmeet — meeting state machine (spec §4).
//
// Deterministic phases: prep -> opening -> discussion (N rounds) -> convergence
// -> extraction. The LLM only ever acts *inside* a phase; there is no
// free-form round-robin. See prompts.ts for the Hebrew prompt text and
// schemas.ts for the structured-output JSON schemas.

import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  Meeting,
  MeetingResult,
  MeetingType,
  OrgSettings,
  Persona,
  TranscriptEntry,
} from '../types';
import { MODELS } from '../types';
import { callModel as realCallModel, CallModelResult } from '../anthropic';
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

/** Maps SDK/network errors to a Hebrew sentence for the transcript — never surfaces raw SDK text. */
function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'הקריאה למודל חרגה מזמן ההמתנה המותר.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'ספק המודל מוגבל כרגע בקצב הבקשות (Rate Limit).';
  }
  if (err instanceof Anthropic.InternalServerError) {
    return 'שגיאת שרת זמנית אצל ספק המודל.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'שגיאת תקשורת בקריאה לספק המודל.';
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return 'מפתח ה-API של Anthropic אינו תקין או נדחה.';
  }
  if (err instanceof Anthropic.APIError) {
    return `שגיאה מספק המודל (קוד ${err.status ?? 'לא ידוע'}).`;
  }
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
 *
 * `signal` — aborts a model call already in flight the moment the run route
 * aborts it (see run-registry.ts). Cancellation is otherwise detected by
 * re-reading `meeting.status` from the store at the head of every phase and
 * before every discussion turn, so it also works across process restarts.
 */
export async function runMeeting(
  meetingId: string,
  onEvent: OnEvent,
  overrideDeps: Partial<RunMeetingDeps> = {},
  apiKey?: string,
  signal?: AbortSignal
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

  let currentPhase: PhaseName = 'prep';

  async function emitPhase(phase: PhaseName): Promise<void> {
    currentPhase = phase;
    onEvent({ type: 'phase', phase });
    // Never resurrect a meeting the user already cancelled (P1.1 §3).
    const fresh = await deps.getMeeting(meetingId);
    if (fresh?.status === 'cancelled') return;
    await persist({ status: 'running' });
  }

  /**
   * Authoritative, store-backed cancellation check. If the meeting was
   * cancelled (via PATCH, from any process), records a system line, persists
   * `status:'cancelled'`, emits the cancelled event, and returns true so the
   * caller can `return` out of runMeeting immediately.
   */
  async function bailIfCancelled(): Promise<boolean> {
    const fresh = await deps.getMeeting(meetingId);
    if (fresh?.status !== 'cancelled') return false;
    const entry = makeEntry(currentPhase, 'system', 'מערכת', 'הפגישה בוטלה על ידי המשתמש.');
    transcript = [...transcript, entry];
    onEvent({ type: 'entry', entry });
    await deps.updateMeeting(meetingId, { transcript, usage });
    onEvent({ type: 'cancelled' });
    return true;
  }

  // P2.2 — meeting-wide cost cap (org.maxMeetingApiCalls / maxMeetingTokens).
  // Once exceeded, the discussion is cut short and the run jumps straight to
  // extraction so the user still gets a useful result from what did happen.
  let budgetCapHit: string | null = null;

  async function checkBudgetCap(): Promise<boolean> {
    const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
    const callsExceeded = usage.apiCalls >= org.maxMeetingApiCalls;
    const tokensExceeded = totalTokens >= org.maxMeetingTokens;
    if (!callsExceeded && !tokensExceeded) return false;
    if (!budgetCapHit) {
      budgetCapHit = callsExceeded
        ? `הפגישה חצתה את תקרת הקריאות למודל שהוגדרה בהגדרות הארגון (${org.maxMeetingApiCalls}). הדיון הופסק וממשיכים ישירות לחילוץ המשימות מהתמליל הקיים.`
        : `הפגישה חצתה את תקרת הטוקנים שהוגדרה בהגדרות הארגון (${org.maxMeetingTokens.toLocaleString('he-IL')}). הדיון הופסק וממשיכים ישירות לחילוץ המשימות מהתמליל הקיים.`;
      await emitEntry(makeEntry(currentPhase, 'system', 'מערכת', budgetCapHit));
    }
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

  await persist({ status: 'running', error: null });

  // -------------------------------------------------------------------
  // Phase 0 — prep (parallel, no visibility into other personas' output)
  // -------------------------------------------------------------------
  await emitPhase('prep');
  if (await bailIfCancelled()) return;
  const prepResults = new Map<string, PrepOutput>();

  const prepAttempts = await Promise.allSettled(
    participants.map(async (persona) => {
      recordApiCall();
      try {
        const result = await deps.callModel({
          model: persona.model,
          system: prompts.buildPersonaSystemBlocks(org, persona),
          messages: [{ role: 'user', content: prompts.buildPrepUserMessage(meeting, meetingTypes) }],
          maxTokens: REGULAR_MAX_TOKENS,
          effort: 'medium',
          jsonSchema: PREP_SCHEMA,
          webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
          apiKey,
          signal,
        });
        return result;
      } finally {
        budget.record(persona.id);
      }
    })
  );

  if (await bailIfCancelled()) return;

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
  await emitPhase('opening');
  if (await bailIfCancelled()) return;
  await checkBudgetCap();
  let opening: OpeningOutput = { framing: '', conflicts: [] };
  if (!budgetCapHit) {
    recordApiCall();
    try {
      const result = await deps.callModel({
        model: MODELS.facilitator,
        system: prompts.buildFacilitatorSystemBlocks(org),
        messages: [
          {
            role: 'user',
            content: prompts.buildOpeningUserMessage(meeting, meetingTypes, participants, prepResults),
          },
        ],
        maxTokens: REGULAR_MAX_TOKENS,
        effort: 'high',
        jsonSchema: OPENING_SCHEMA,
        apiKey,
        signal,
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
      if (await bailIfCancelled()) return;
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
  if (await bailIfCancelled()) return;
  await checkBudgetCap();
  const totalRounds = meeting.discussionRounds;

  discussionLoop: for (let round = 1; round <= totalRounds; round++) {
    for (const persona of participants) {
      if (await bailIfCancelled()) return;
      if (await checkBudgetCap()) break discussionLoop;

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
          apiKey,
          signal,
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
        if (await bailIfCancelled()) return;
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
  if (await bailIfCancelled()) return;
  await checkBudgetCap();
  let convergenceSummary = budgetCapHit ? '(הדיון נעצר עקב חריגה מתקרת העלות; יש להתבסס על התמליל שנצבר בלבד.)' : '';
  if (!budgetCapHit) {
    recordApiCall();
    try {
      const result = await deps.callModel({
        model: MODELS.facilitator,
        system: prompts.buildFacilitatorSystemBlocks(org),
        messages: [
          { role: 'user', content: prompts.buildConvergenceUserMessage(meeting, meetingTypes, transcript) },
        ],
        maxTokens: REGULAR_MAX_TOKENS,
        effort: 'high',
        apiKey,
        signal,
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
      if (await bailIfCancelled()) return;
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
  if (await bailIfCancelled()) return;
  try {
    recordApiCall();
    const result = await deps.callModel({
      model: MODELS.facilitator,
      system: prompts.buildFacilitatorSystemBlocks(org),
      messages: [
        {
          role: 'user',
          content: prompts.buildExtractionUserMessage(meeting, meetingTypes, participants, transcript, convergenceSummary),
        },
      ],
      maxTokens: REGULAR_MAX_TOKENS,
      effort: 'high',
      jsonSchema: EXTRACTION_SCHEMA,
      apiKey,
      signal,
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
      modelAssumptions: budgetCapHit ? [...raw.modelAssumptions, budgetCapHit] : raw.modelAssumptions,
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

    await persist({ status: 'completed', result: finalResult, completedAt: nowIso(), error: null });
    onEvent({ type: 'done', result: finalResult });
  } catch (err) {
    if (await bailIfCancelled()) return;
    const message = errorMessage(err);
    await persist({ status: 'failed', error: message });
    onEvent({ type: 'error', message });
  }
}
