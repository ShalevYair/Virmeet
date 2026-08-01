// Virmeet — meeting state machine (spec §4).
//
// Deterministic phases: prep -> opening -> discussion (N rounds) -> convergence
// -> extraction. The LLM only ever acts *inside* a phase; there is no
// free-form round-robin. See prompts.ts for the Hebrew prompt text and
// schemas.ts for the structured-output JSON schemas.

import {
  AttachedFile,
  Meeting,
  MeetingResult,
  MeetingType,
  OrgSettings,
  Persona,
  TranscriptEntry,
  UNASSIGNED_TASK_OWNER_FALLBACK,
} from '../types';
import { callModel as realCallModel } from '../gemini';
import { CallModelResult } from '../llm-types';
import { getDriveAccessToken } from '../drive-session';
import {
  getMeeting as storeGetMeeting,
  getOrgSettings as storeGetOrgSettings,
  listMeetingTypes as storeListMeetingTypes,
  listPersonas as storeListPersonas,
  updateMeeting as storeUpdateMeeting,
} from '../store';
import { CallBudget } from './budget';
import { fetchDeepReadAttachedFile, MAX_DEEP_READ_FILES_PER_PERSONA, refreshPersonaDriveIndex } from './drive-knowledge';
import type { RefreshResult } from './drive-knowledge';
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
  refreshDriveKnowledge: (folderId, apiKey, signal) => {
    const token = getDriveAccessToken();
    if (!token) {
      return Promise.reject(new Error('אין חיבור פעיל ל-Drive (יש להתחבר מחדש בהגדרות).'));
    }
    return refreshPersonaDriveIndex(token, folderId, realCallModel, apiKey, signal);
  },
  fetchDriveDeepReadFile: (fileId, fileName) => {
    const token = getDriveAccessToken();
    if (!token) {
      return Promise.reject(new Error('אין חיבור פעיל ל-Drive (יש להתחבר מחדש בהגדרות).'));
    }
    return fetchDeepReadAttachedFile(token, fileId, fileName);
  },
};

// The model reports ownerName as UNASSIGNED_OWNER_NAME when it can't tie a
// task to a specific participant (see EXTRACTION_SCHEMA / the extraction
// prompt). Rather than shipping a task with no owner, we hand it to the
// project manager (UNASSIGNED_TASK_OWNER_FALLBACK) — the seed persona whose
// whole job is exactly this ("משימה שאין לה בעלים ברור").
const UNASSIGNED_OWNER_NAME = 'לא שויך';

/** Resolves a task's raw owner name to who it should actually be assigned to, falling back to the project manager when the model reports no clear owner. */
export function resolveTaskOwnerName(rawOwnerName: string): string {
  const trimmed = rawOwnerName.trim();
  return trimmed === '' || trimmed === UNASSIGNED_OWNER_NAME ? UNASSIGNED_TASK_OWNER_FALLBACK : trimmed;
}

const REGULAR_MAX_TOKENS = 8000;
// The extraction call is the only one that must emit the entire
// EXTRACTION_SCHEMA in one response, and it runs at effort:'high' — where
// thinking tokens come out of the same budget. A truncation here loses the
// whole meeting's output, so it gets its own, larger budget.
const EXTRACTION_MAX_TOKENS = 20000;

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
 * Gemini client (see ../gemini.ts).
 *
 * `apiKey` — the personal Gemini key read out of localStorage in the browser
 * (see api-key.ts) — is forwarded to every model call below and nowhere
 * else: it is never added to `meeting`, `transcript`, or any persisted
 * patch, so it can't reach IndexedDB or the exported transcript.
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
  apiKey?: string,
  signal?: AbortSignal
): Promise<void> {
  const deps: RunMeetingDeps = { ...defaultDeps, ...overrideDeps };

  function isAborted(): boolean {
    return signal?.aborted === true;
  }

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
  // A meeting persisted before cacheWriteTokens existed has no such field in
  // IndexedDB — default it, or `undefined + n` below silently poisons every
  // subsequent usage number with NaN. (IndexedDB doesn't enforce the type
  // above at the record level, so this can happen despite the static type.)
  let usage: Meeting['usage'] = { ...meeting.usage, cacheWriteTokens: meeting.usage.cacheWriteTokens ?? 0 };

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
      cacheWriteTokens: usage.cacheWriteTokens + u.cacheWriteTokens,
    };
  }

  if (await abortIfCancelled('prep')) return;
  await persist({ status: 'running', error: null });

  // -------------------------------------------------------------------
  // Phase 0 — prep (parallel, no visibility into other personas' output)
  // -------------------------------------------------------------------
  if (await abortIfCancelled('prep')) return;
  await emitPhase('prep');

  // Refresh each Drive-connected participant's knowledge-folder index
  // before anyone's prep call runs — sequential and synchronous with this
  // phase (not a model call, so it doesn't touch budget/usage). A failure
  // here degrades that one persona back to whatever local files it already
  // has; it never fails the meeting. Results are kept around (not just
  // logged): the index summaries go into every one of that persona's system
  // blocks from here on, and `fileIdsByName` lets the deep-read step below
  // resolve names the persona names in its prep output back to Drive ids.
  const driveIndexByPersona = new Map<string, RefreshResult>();
  if (deps.refreshDriveKnowledge) {
    for (const persona of participants) {
      if (!persona.driveFolderId) continue;
      if (await abortIfCancelled('prep')) return;
      try {
        const refresh = await deps.refreshDriveKnowledge(persona.driveFolderId, apiKey, signal);
        driveIndexByPersona.set(persona.id, refresh);
        const truncatedNote = refresh.truncated
          ? ' (הגיע למגבלת העדכונים לריצה אחת — חלק מהקבצים לא עודכנו הפעם)'
          : '';
        await emitEntry(
          makeEntry(
            'prep',
            'system',
            'מערכת',
            `אינדקס הידע של ${persona.name} מ-Drive עודכן — ${refresh.changedCount} קבצים חדשים/עודכנו מתוך ${refresh.totalCount}.${truncatedNote}`
          )
        );
      } catch (err) {
        if (!isAborted()) {
          await emitEntry(
            makeEntry(
              'prep',
              'system',
              'מערכת',
              `רענון אינדקס הידע של ${persona.name} מ-Drive נכשל (${errorMessage(err)}). ממשיכים בלעדיו.`
            )
          );
        }
      }
    }
  }

  const prepResults = new Map<string, PrepOutput>();

  const prepAttempts = await Promise.allSettled(
    participants.map(async (persona) => {
      recordApiCall();
      try {
        const result = await deps.callModel({
          model: meeting.model,
          system: prompts.buildPersonaSystemBlocks(org, persona, meeting, {
            indexSummary: driveIndexByPersona.get(persona.id)?.files,
          }),
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

  if (await abortIfCancelled('prep')) return;

  // Process in participant order (not settle order) so the transcript reads
  // deterministically even though the calls above ran concurrently.
  for (let i = 0; i < participants.length; i++) {
    const persona = participants[i];
    const attempt = prepAttempts[i];

    if (attempt.status === 'rejected') {
      // A cancelled run aborts every in-flight prep call at once — those
      // rejections are the cancellation, not a persona failure, and the
      // cancellation line (written by abortIfCancelled right after this
      // loop) shouldn't be preceded by a wall of fake per-persona errors.
      if (!isAborted()) {
        await emitEntry(
          makeEntry('prep', 'system', 'מערכת', prompts.personaErrorLine(persona.name, errorMessage(attempt.reason)))
        );
      }
      continue;
    }

    const result = attempt.value;
    recordTokens(result.usage);

    if (result.refused) {
      await emitEntry(makeEntry('prep', 'system', 'מערכת', prompts.personaRefusedLine(persona.name)));
      continue;
    }

    if (result.truncated) {
      await emitEntry(makeEntry('prep', 'system', 'מערכת', prompts.personaTruncatedInPrepLine(persona.name)));
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

  // Deep-read: fetch the full text of whatever files each persona named in
  // its own prep output (filesToReadInDepth), resolved against that
  // persona's Drive index from the refresh step above. Not a model call —
  // just a download + local extraction — so it doesn't touch budget/usage.
  // The result gets folded into that persona's system blocks for every
  // remaining call this run (discussion onward); a per-file failure just
  // drops that one file rather than failing the persona or the meeting.
  const driveDeepReadByPersona = new Map<string, AttachedFile[]>();
  if (deps.fetchDriveDeepReadFile) {
    for (const persona of participants) {
      const requested = prepResults.get(persona.id)?.filesToReadInDepth ?? [];
      const fileIdsByName = driveIndexByPersona.get(persona.id)?.fileIdsByName ?? {};
      if (requested.length === 0) continue;
      if (await abortIfCancelled('prep')) return;

      const fetched: AttachedFile[] = [];
      for (const name of requested.slice(0, MAX_DEEP_READ_FILES_PER_PERSONA)) {
        const fileId = fileIdsByName[name];
        if (!fileId) continue; // model named a file not in its index (hallucinated/stale) — skip silently
        try {
          fetched.push(await deps.fetchDriveDeepReadFile(fileId, name));
        } catch (err) {
          if (!isAborted()) {
            await emitEntry(
              makeEntry(
                'prep',
                'system',
                'מערכת',
                `קריאה לעומק של הקובץ "${name}" עבור ${persona.name} נכשלה (${errorMessage(err)}).`
              )
            );
          }
        }
      }
      if (fetched.length > 0) {
        driveDeepReadByPersona.set(persona.id, fetched);
        await emitEntry(
          makeEntry(
            'prep',
            'system',
            'מערכת',
            `${persona.name} קרא/ה לעומק מ-Drive: ${fetched.map((f) => f.name).join(', ')}.`
          )
        );
      }
    }
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
        model: meeting.model,
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
      } else if (result.truncated) {
        opening = {
          framing: 'תשובת המנחה בשלב הפתיחה נקטעה בשל מגבלת אורך — יש להתייחס לתמליל ההכנה של המשתתפים בלבד.',
          conflicts: [],
        };
        await emitEntry(makeEntry('opening', 'system', 'מערכת', prompts.facilitatorTruncatedInOpeningLine()));
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
      // A cancelled run aborts the in-flight call, which rejects here — that's
      // the cancellation, not a real facilitator failure; don't write a fake
      // error line ahead of the cancellation line abortIfCancelled adds next.
      if (!isAborted()) {
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
          model: meeting.model,
          system: prompts.buildPersonaSystemBlocks(org, persona, meeting, {
            indexSummary: driveIndexByPersona.get(persona.id)?.files,
            deepReadFiles: driveDeepReadByPersona.get(persona.id),
          }),
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
          makeEntry(
            'discussion',
            persona.id,
            persona.name,
            result.truncated ? `${result.text}${prompts.discussionTruncatedSuffix()}` : result.text,
            {
              round,
              webSearches: result.webSearches.length ? result.webSearches : undefined,
              usage: result.usage,
            }
          )
        );
      } catch (err) {
        budget.record(persona.id);
        // A cancelled run aborts the in-flight call, which rejects here —
        // that's the cancellation, not this persona failing; the next loop
        // iteration's abortIfCancelled writes the real cancellation line.
        if (!isAborted()) {
          await emitEntry(
            makeEntry('discussion', 'system', 'מערכת', prompts.personaErrorLine(persona.name, errorMessage(err)), {
              round,
            })
          );
        }
      }
    }

    // The meeting creator (a human, not a persona) gets one turn per round,
    // after every persona has spoken — never billed against usage/budget,
    // since it isn't a model call. `requestCreatorTurn` resolves with '' if
    // the creator skips the round.
    if (meeting.creatorParticipates && deps.requestCreatorTurn) {
      if (await abortIfCancelled('discussion', round)) return;
      const creatorText = (await deps.requestCreatorTurn({ round, totalRounds })).trim();
      if (creatorText) {
        await emitEntry(makeEntry('discussion', 'creator', 'יוצר הפגישה', creatorText, { round }));
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
        model: meeting.model,
        system: prompts.buildFacilitatorSystemBlocks(org, meeting),
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
      convergenceSummary = '(שלב ההתכנסות נכשל; יש להתבסס על התמליל המלא בלבד.)';
      // A cancelled run aborts the in-flight call, which rejects here —
      // that's the cancellation, not a real facilitator failure; don't write
      // a fake error line ahead of the cancellation line added next.
      if (!isAborted()) {
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
      model: meeting.model,
      system: prompts.buildFacilitatorSystemBlocks(org, meeting),
      messages: [
        {
          role: 'user',
          content: prompts.buildExtractionUserMessage(meeting, meetingTypes, participants, transcript, convergenceSummary),
        },
      ],
      maxTokens: EXTRACTION_MAX_TOKENS,
      effort: 'high',
      jsonSchema: EXTRACTION_SCHEMA,
      apiKey,
      signal,
    });
    recordTokens(result.usage);

    if (result.refused) {
      throw new Error('המנחה סירב לספק את חילוץ המשימות והתוצאות של הפגישה.');
    }
    if (result.truncated) {
      throw new Error(prompts.extractionTruncatedError());
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
      tasks: raw.tasks.map((t) => {
        const ownerName = resolveTaskOwnerName(t.ownerName);
        return {
          id: crypto.randomUUID(),
          title: t.title,
          description: t.description,
          ownerPersonaId: personaIdByName.get(ownerName) ?? null,
          ownerName,
          priority: t.priority,
          dependsOn: t.dependsOn,
          assumption: t.assumption,
          riskIfAssumptionWrong: t.riskIfAssumptionWrong,
        };
      }),
    };

    const title = raw.title.trim() || meeting.title;
    await persist({ status: 'completed', result: finalResult, completedAt: nowIso(), error: null, title });
    onEvent({ type: 'done', result: finalResult });
  } catch (err) {
    const message = errorMessage(err);
    await persist({ status: 'failed', error: message });
    onEvent({ type: 'error', message });
  }
}
