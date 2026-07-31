// Virmeet — meeting engine internal types (spec §4).
// These types describe the runner's public event contract and the pieces it
// depends on. Kept separate from src/lib/types.ts (the persisted data model).

import { Meeting, MeetingPhase, MeetingResult, MeetingType, OrgSettings, Persona, TranscriptEntry } from '../types';
import { CallModelOptions, CallModelResult, CallModelUsage } from '../anthropic';

export type PhaseName = MeetingPhase;

/** Non-null variant of TranscriptEntry['usage'] — a call's raw token usage plus its estimated cost. */
export type CallUsageWithCost = CallModelUsage & { costUsd: number };

/** Events streamed out of runMeeting() — mirrors the SSE payloads verbatim (spec §4, §5). */
export type MeetingEvent =
  | { type: 'phase'; phase: PhaseName }
  // Sent right before each persona model call starts (prep/discussion only —
  // a UX cue for the 20-60s a turn can take, not a source of truth; the
  // polling fallback never sees it. C2 in WORKPLAN.md.
  | { type: 'speaking'; speakerId: string; speakerName: string; round?: number }
  | { type: 'entry'; entry: TranscriptEntry }
  // `usage` is the extraction call's own usage — the only model call in the
  // run that never produces a transcript entry, so callers accumulating cost
  // from 'entry' events need this to see the full picture (C1 in WORKPLAN.md).
  | { type: 'done'; result: MeetingResult; usage: CallUsageWithCost }
  | { type: 'error'; message: string };

export type OnEvent = (event: MeetingEvent) => void;

/**
 * The one seam the engine calls through to reach the model. Production code
 * passes the real `callModel` from src/lib/anthropic.ts; tests inject a stub
 * so runMeeting() never has to hit the live API to be exercised.
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
}

export interface PrepOutput {
  understanding: string;
  concerns: string[];
  questions: string[];
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
