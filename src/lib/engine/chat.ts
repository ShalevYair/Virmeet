// Virmeet — post-meeting chat: free-form Q&A with the facilitator or one
// specific persona, plus additional discussion rounds, both available once a
// meeting has completed (spec: post-session chat management). Unlike
// runner.ts, there is no phase state machine here — each function is a
// single, independent turn a user can trigger any number of times from the
// meeting's own page, whether it just finished running or is being reopened
// long after the fact (same route either way — see meetings/view/page.tsx).

import {
  ChatMessage,
  Meeting,
  MeetingType,
  OrgSettings,
  Persona,
  TranscriptEntry,
} from '../types';
import { callModel as realCallModel } from '../gemini';
import { CallModelResult } from '../llm-types';
import {
  getMeeting as storeGetMeeting,
  getOrgSettings as storeGetOrgSettings,
  listMeetingTypes as storeListMeetingTypes,
  listPersonas as storeListPersonas,
  updateMeeting as storeUpdateMeeting,
} from '../store';
import * as prompts from './prompts';
import type { RunMeetingDeps } from './types';

/** The subset of RunMeetingDeps this module actually needs — no drive knowledge, no creator-turn prompt, no budget: those are run-time-only concerns. */
export type ChatDeps = Pick<
  RunMeetingDeps,
  'callModel' | 'updateMeeting' | 'getMeeting' | 'getPersonas' | 'getMeetingTypes' | 'getOrgSettings'
>;

const defaultDeps: ChatDeps = {
  callModel: realCallModel,
  updateMeeting: storeUpdateMeeting,
  getMeeting: storeGetMeeting,
  getPersonas: storeListPersonas,
  getMeetingTypes: storeListMeetingTypes,
  getOrgSettings: storeGetOrgSettings,
};

// Q&A turns are meant to be short, direct answers — not another full
// discussion-phase response — so this is deliberately smaller than
// runner.ts's REGULAR_MAX_TOKENS (8000).
const CHAT_MAX_TOKENS = 4000;
const ROUND_MAX_TOKENS = 8000;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface LoadedContext {
  meeting: Meeting;
  participants: Persona[];
  meetingTypes: MeetingType[];
  org: OrgSettings;
}

/** Shared setup for every chat/round entry point: loads the meeting and its resolved participants/types/org, and enforces that the meeting has actually finished. */
async function loadContext(meetingId: string, deps: ChatDeps): Promise<LoadedContext> {
  const meeting = await deps.getMeeting(meetingId);
  if (!meeting) throw new Error('הפגישה לא נמצאה.');
  if (meeting.status !== 'completed') {
    throw new Error('אפשר לנהל צ׳אט או לפתוח סבב דיון נוסף רק בפגישה שהסתיימה.');
  }

  const allPersonas = await deps.getPersonas();
  const personaById = new Map(allPersonas.map((p) => [p.id, p]));
  const participants = meeting.participantIds
    .map((id) => personaById.get(id))
    .filter((p): p is Persona => p != null);

  const allMeetingTypes = await deps.getMeetingTypes();
  const meetingTypeById = new Map(allMeetingTypes.map((t) => [t.id, t]));
  const meetingTypes = meeting.meetingTypeIds
    .map((id) => meetingTypeById.get(id))
    .filter((t): t is MeetingType => t != null);

  const org = await deps.getOrgSettings();

  return { meeting, participants, meetingTypes, org };
}

/** Adds one call's usage onto `usage` — mirrors runner.ts#recordTokens, including its `cacheWriteTokens ?? 0` guard for meetings persisted before that field existed. */
function addUsage(usage: Meeting['usage'], u: CallModelResult['usage']): Meeting['usage'] {
  return {
    inputTokens: usage.inputTokens + u.inputTokens,
    outputTokens: usage.outputTokens + u.outputTokens,
    cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
    cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
    apiCalls: usage.apiCalls + 1,
  };
}

/**
 * Asks a general question about the finished meeting — answered by the
 * facilitator persona (org + shared-files context, no single participant's
 * point of view), grounded in the full transcript and result. Persists the
 * exchange onto `meeting.chat` and returns it.
 */
export async function askGeneralChatQuestion(
  meetingId: string,
  question: string,
  overrideDeps: Partial<ChatDeps> = {},
  apiKey?: string,
  signal?: AbortSignal
): Promise<ChatMessage> {
  const deps: ChatDeps = { ...defaultDeps, ...overrideDeps };
  const { meeting, meetingTypes, org } = await loadContext(meetingId, deps);
  const priorChat = meeting.chat.filter((c) => c.mode === 'general');

  const result = await deps.callModel({
    model: meeting.model,
    system: prompts.buildFacilitatorSystemBlocks(org, meeting),
    messages: [
      {
        role: 'user',
        content: prompts.buildGeneralChatUserMessage(
          meeting,
          meetingTypes,
          meeting.transcript,
          meeting.result,
          priorChat,
          question
        ),
      },
    ],
    maxTokens: CHAT_MAX_TOKENS,
    effort: 'medium',
    apiKey,
    signal,
  });

  const chatMessage: ChatMessage = {
    id: crypto.randomUUID(),
    mode: 'general',
    question,
    answer: result.refused ? '' : result.text,
    refused: result.refused || undefined,
    createdAt: nowIso(),
  };

  await deps.updateMeeting(meetingId, {
    chat: [...meeting.chat, chatMessage],
    usage: addUsage(meeting.usage, result.usage),
  });

  return chatMessage;
}

/**
 * Asks one specific participant a question, in character, after the meeting
 * has ended. Persists the exchange onto `meeting.chat` (tagged with
 * `personaId`) and returns it.
 */
export async function askPersonaChatQuestion(
  meetingId: string,
  personaId: string,
  question: string,
  overrideDeps: Partial<ChatDeps> = {},
  apiKey?: string,
  signal?: AbortSignal
): Promise<ChatMessage> {
  const deps: ChatDeps = { ...defaultDeps, ...overrideDeps };
  const { meeting, participants, meetingTypes, org } = await loadContext(meetingId, deps);
  const persona = participants.find((p) => p.id === personaId);
  if (!persona) throw new Error('המשתתף שנבחר אינו חלק מהפגישה הזו.');

  const priorChat = meeting.chat.filter((c) => c.mode === 'persona' && c.personaId === personaId);

  const result = await deps.callModel({
    model: meeting.model,
    system: prompts.buildPersonaSystemBlocks(org, persona, meeting),
    messages: [
      {
        role: 'user',
        content: prompts.buildPersonaChatUserMessage(
          meeting,
          meetingTypes,
          persona,
          meeting.transcript,
          meeting.result,
          priorChat,
          question
        ),
      },
    ],
    maxTokens: CHAT_MAX_TOKENS,
    effort: 'medium',
    webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
    apiKey,
    signal,
  });

  const chatMessage: ChatMessage = {
    id: crypto.randomUUID(),
    mode: 'persona',
    personaId,
    question,
    answer: result.refused ? '' : result.text,
    refused: result.refused || undefined,
    createdAt: nowIso(),
  };

  await deps.updateMeeting(meetingId, {
    chat: [...meeting.chat, chatMessage],
    usage: addUsage(meeting.usage, result.usage),
  });

  return chatMessage;
}

/**
 * Opens one additional discussion round on `topic`, after the meeting has
 * already ended: every original participant gets one turn, same voice/rules
 * as a live discussion round (runner.ts phase 2), appended to
 * `meeting.transcript` with the next round number and streamed via
 * `onEntry` as each one lands. Unlike the Q&A functions above, this extends
 * the meeting's actual record, not a separate chat log — `discussionRounds`
 * is bumped to match so exports reflect the true round count. Never rejects:
 * a per-persona failure becomes a system transcript line, same as during the
 * original run.
 */
export async function runAdditionalDiscussionRound(
  meetingId: string,
  topic: string,
  overrideDeps: Partial<ChatDeps> = {},
  apiKey?: string,
  signal?: AbortSignal,
  onEntry?: (entry: TranscriptEntry) => void
): Promise<TranscriptEntry[]> {
  const deps: ChatDeps = { ...defaultDeps, ...overrideDeps };
  const { meeting, participants, meetingTypes, org } = await loadContext(meetingId, deps);

  const priorRounds = meeting.transcript
    .filter((e) => e.phase === 'discussion' && typeof e.round === 'number')
    .map((e) => e.round as number);
  const round = (priorRounds.length > 0 ? Math.max(...priorRounds) : 0) + 1;

  let transcript = meeting.transcript;
  let usage = meeting.usage;
  const newEntries: TranscriptEntry[] = [];

  async function emit(entry: TranscriptEntry): Promise<void> {
    transcript = [...transcript, entry];
    newEntries.push(entry);
    onEntry?.(entry);
    await deps.updateMeeting(meetingId, {
      transcript,
      usage,
      discussionRounds: Math.max(meeting.discussionRounds, round),
    });
  }

  function isAborted(): boolean {
    return signal?.aborted === true;
  }

  await emit({
    id: crypto.randomUUID(),
    phase: 'discussion',
    speakerId: 'system',
    speakerName: 'מערכת',
    text: `נפתח סבב דיון נוסף (סבב ${round}) בנושא: ${topic}`,
    round,
    createdAt: nowIso(),
  });

  for (const persona of participants) {
    if (isAborted()) break;
    try {
      const result = await deps.callModel({
        model: meeting.model,
        system: prompts.buildPersonaSystemBlocks(org, persona, meeting),
        messages: [
          {
            role: 'user',
            content: prompts.buildAdditionalRoundUserMessage(meeting, meetingTypes, persona, round, transcript, topic),
          },
        ],
        maxTokens: ROUND_MAX_TOKENS,
        effort: 'medium',
        webSearch: persona.webAccess ? { maxUses: persona.maxWebSearches } : undefined,
        apiKey,
        signal,
      });
      usage = addUsage(usage, result.usage);

      if (result.refused) {
        await emit({
          id: crypto.randomUUID(),
          phase: 'discussion',
          speakerId: 'system',
          speakerName: 'מערכת',
          text: prompts.personaRefusedLine(persona.name),
          round,
          createdAt: nowIso(),
        });
        continue;
      }

      await emit({
        id: crypto.randomUUID(),
        phase: 'discussion',
        speakerId: persona.id,
        speakerName: persona.name,
        text: result.truncated ? `${result.text}${prompts.discussionTruncatedSuffix()}` : result.text,
        round,
        webSearches: result.webSearches.length ? result.webSearches : undefined,
        usage: result.usage,
        createdAt: nowIso(),
      });
    } catch (err) {
      // An aborted run rejects the in-flight call — that's the cancellation,
      // not a real persona failure, so don't write a fake error line for it.
      if (!isAborted()) {
        await emit({
          id: crypto.randomUUID(),
          phase: 'discussion',
          speakerId: 'system',
          speakerName: 'מערכת',
          text: prompts.personaErrorLine(persona.name, errorMessage(err)),
          round,
          createdAt: nowIso(),
        });
      }
    }
  }

  return newEntries;
}
