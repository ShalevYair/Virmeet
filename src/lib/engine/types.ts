// Virmeet — meeting engine internal types (spec §4).
// These types describe the runner's public event contract and the pieces it
// depends on. Kept separate from src/lib/types.ts (the persisted data model).

import { AttachedFile, Meeting, MeetingPhase, MeetingResult, MeetingType, OrgSettings, Persona, TranscriptEntry } from '../types';
import { CallModelOptions, CallModelResult } from '../llm-types';
import type { PersonaKnowledgeFile } from './drive-knowledge';

export type PhaseName = MeetingPhase;

/** Events streamed out of runMeeting() — mirrors the SSE payloads verbatim (spec §4, §5). */
export type MeetingEvent =
  | { type: 'phase'; phase: PhaseName }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'done'; result: MeetingResult }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export type OnEvent = (event: MeetingEvent) => void;

/**
 * The one seam the engine calls through to reach the model. Production code
 * passes the real `callModel` from src/lib/gemini.ts; tests inject a stub so
 * runMeeting() never has to hit a live API to be exercised.
 */
export type CallModelFn = (opts: CallModelOptions) => Promise<CallModelResult>;

export interface RunMeetingDeps {
  callModel: CallModelFn;
  /** Persist a partial update to the meeting. Mirrors store.ts#updateMeeting. */
  updateMeeting: (id: string, patch: Partial<Meeting>) => Promise<Meeting | null>;
  /** Fetch entities the engine needs to build prompts. Mirrors store.ts getters. */
  getMeeting: (id: string) => Promise<Meeting | null>;
  getPersonas: () => Promise<Persona[]>;
  getMeetingTypes: () => Promise<MeetingType[]>;
  getOrgSettings: () => Promise<OrgSettings>;
  /**
   * Called once per discussion round, after every persona has spoken, when
   * `meeting.creatorParticipates` is true — lets the human running the
   * simulation add their own line to that round. Resolves with the entered
   * text, or `''` to skip that round. Optional: only the browser UI supplies
   * a real implementation (see api-client.ts#runMeeting); tests that don't
   * exercise creator participation never need it.
   */
  requestCreatorTurn?: (info: { round: number; totalRounds: number }) => Promise<string>;
  /**
   * Refreshes one persona's Drive knowledge-folder index (see
   * engine/drive-knowledge.ts) right before `prep` starts. Called once per
   * participant that has `persona.driveFolderId` set. Throws on failure
   * (no Drive session, network error, ...) — the runner catches per-persona
   * and degrades gracefully, same as every other per-persona failure.
   * Optional: omitted entirely disables Drive knowledge refresh (e.g. in
   * tests that don't exercise it).
   */
  refreshDriveKnowledge?: (
    folderId: string,
    apiKey: string | undefined,
    signal: AbortSignal | undefined
  ) => Promise<{
    files: PersonaKnowledgeFile[];
    fileIdsByName: Record<string, string>;
    changedCount: number;
    totalCount: number;
    truncated: boolean;
  }>;
  /**
   * Fetches one Drive file's full extracted text (as an `AttachedFile`) —
   * called right after `prep`, once per file a persona named in its
   * `filesToReadInDepth` (see PrepOutput). Throws on failure (no Drive
   * session, download/extraction error); the runner catches per-file and
   * just skips it. Optional: omitted disables deep-read fetching (e.g. in
   * tests that don't exercise it).
   */
  fetchDriveDeepReadFile?: (fileId: string, fileName: string) => Promise<AttachedFile>;
}

export interface PrepOutput {
  understanding: string;
  concerns: string[];
  questions: string[];
  filesToReadInDepth: string[];
}

export interface OpeningConflict {
  topic: string;
  sides: string;
  whoDisagrees: string[];
}

export interface OpeningOutput {
  framing: string;
  conflicts: OpeningConflict[];
}
