// Virmeet — POST /api/meetings/[id]/extract: reruns *only* phase 4
// (extraction) for a meeting that failed after its transcript was already
// saved, instead of the discussion having to be redone from scratch (A3 in
// WORKPLAN.md).

import { NextResponse } from 'next/server';
import { getMeeting, getOrgSettings, listMeetingTypes, listPersonas, updateMeeting } from '@/lib/store';
import { runExtraction } from '@/lib/engine/runner';
import { MeetingType, MODELS, Persona, TranscriptEntry } from '@/lib/types';
import { estimateCallCostUsd } from '@/lib/pricing';
import { internalError, jsonError, requireApiKey, validateId } from '../../../_lib/http';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** convergenceSummary isn't stored on Meeting — recover it from the facilitator's last convergence line. */
function reconstructConvergenceSummary(transcript: TranscriptEntry[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (entry.phase === 'convergence' && entry.speakerId === 'facilitator') return entry.text;
  }
  return '(לא נמצא סיכום התכנסות בתמליל; יש להתבסס על התמליל המלא בלבד.)';
}

export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;

  const clientApiKey = req.headers.get('x-anthropic-api-key') || undefined;
  const apiKeyError = requireApiKey(clientApiKey);
  if (apiKeyError) return apiKeyError;

  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);
    if (meeting.status !== 'failed') {
      return jsonError('אפשר לחלץ מחדש רק פגישה שנכשלה.', 409);
    }
    if (meeting.transcript.length === 0) {
      return jsonError('אין תמליל לחלץ ממנו — יש להריץ את הפגישה מההתחלה.', 409);
    }

    const [allPersonas, allMeetingTypes, org] = await Promise.all([
      listPersonas(),
      listMeetingTypes(),
      getOrgSettings(),
    ]);
    const personaById = new Map(allPersonas.map((p) => [p.id, p]));
    const participants = meeting.participantIds
      .map((pid) => personaById.get(pid))
      .filter((p): p is Persona => p != null);
    const meetingTypeById = new Map(allMeetingTypes.map((t) => [t.id, t]));
    const meetingTypes = meeting.meetingTypeIds
      .map((tid) => meetingTypeById.get(tid))
      .filter((t): t is MeetingType => t != null);

    const convergenceSummary = reconstructConvergenceSummary(meeting.transcript);

    const outcome = await runExtraction(
      meeting,
      meetingTypes,
      org,
      participants,
      meeting.transcript,
      convergenceSummary,
      clientApiKey
    );

    const costUsd = estimateCallCostUsd(MODELS.facilitator, outcome.usage);
    const usage = {
      inputTokens: meeting.usage.inputTokens + outcome.usage.inputTokens,
      outputTokens: meeting.usage.outputTokens + outcome.usage.outputTokens,
      cacheReadTokens: meeting.usage.cacheReadTokens + outcome.usage.cacheReadTokens,
      cacheCreationTokens: meeting.usage.cacheCreationTokens + outcome.usage.cacheCreationTokens,
      apiCalls: meeting.usage.apiCalls + 1,
      costUsd: meeting.usage.costUsd + costUsd,
    };

    const updated = await updateMeeting(
      id,
      outcome.ok
        ? { status: 'completed', result: outcome.result, completedAt: new Date().toISOString(), error: null, usage }
        : { status: 'failed', error: outcome.error, usage }
    );
    if (!updated) return jsonError('הפגישה לא נמצאה.', 404);
    return NextResponse.json(updated);
  } catch (err) {
    return internalError(err);
  }
}
