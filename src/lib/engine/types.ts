// Virmeet — meeting engine internal types (spec §4).
// These types describe the runner's public event contract and the pieces it
// depends on. Kept separate from src/lib/types.ts (the persisted data model).

import { Meeting, MeetingResult, MeetingType, OrgSettings, Persona, TranscriptEntry } from '../types';
import { CallModelOptions, CallModelResult } from '../anthropic';

export type PhaseName = 'prep' | 'opening' | 'discussion' | 'convergence' | 'extraction';

/** Events streamed out of runMeeting() — mirrors the SSE payloads verbatim (spec §4, §5). */
export type MeetingEvent =
  | { type: 'phase'; phase: PhaseName }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'done'; result: MeetingResult }
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
