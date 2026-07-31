// Virmeet — POST /api/meetings/[id]/ask: ask a persona (or the facilitator) a
// follow-up question after the meeting has completed (spec §6).
//
// This is a single, standalone model call — it does not go through the
// meeting engine's state machine (src/lib/engine/runner.ts). It reuses the
// exact same persona/facilitator system blocks as the live meeting, so the
// persona answers in the same voice and the prompt-cache prefix from the
// meeting run itself can still be read.

import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { getMeeting, getOrgSettings, listMeetingTypes, listPersonas, updateMeeting } from '@/lib/store';
import { callModel } from '@/lib/anthropic';
import { buildFacilitatorSystemBlocks, buildFollowUpUserMessage, buildPersonaSystemBlocks } from '@/lib/engine/prompts';
import { FollowUp, MeetingType, MODELS, Persona } from '@/lib/types';
import { internalError, jsonError, parseJsonBody, requireApiKey } from '../../../_lib/http';
import { askFollowUpSchema } from '../../../_lib/schemas';

const FOLLOW_UP_MAX_TOKENS = 2000;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;

  const clientApiKey = req.headers.get('x-anthropic-api-key') || undefined;
  const apiKeyError = requireApiKey(clientApiKey);
  if (apiKeyError) return apiKeyError;

  const parsed = await parseJsonBody(req, askFollowUpSchema);
  if (!parsed.ok) return parsed.response;
  const { personaId, question } = parsed.data;

  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);
    if (meeting.status !== 'completed') {
      return jsonError('אפשר לשאול שאלות המשך רק על פגישה שהושלמה.', 400);
    }

    const org = await getOrgSettings();
    const allMeetingTypes = await listMeetingTypes();
    const meetingTypeById = new Map(allMeetingTypes.map((t) => [t.id, t]));
    const meetingTypes = meeting.meetingTypeIds
      .map((tid) => meetingTypeById.get(tid))
      .filter((t): t is MeetingType => t != null);

    let personaName: string;
    let system: ReturnType<typeof buildPersonaSystemBlocks>;
    let model: string;

    if (personaId === 'facilitator') {
      personaName = 'מנחה';
      system = buildFacilitatorSystemBlocks(org);
      model = MODELS.facilitator;
    } else {
      const personas = await listPersonas();
      const persona = personas.find((p): p is Persona => p.id === personaId);
      if (!persona) return jsonError('המשתתף שנבחר אינו קיים.', 400);
      personaName = persona.name;
      system = buildPersonaSystemBlocks(org, persona);
      model = persona.model;
    }

    const previousFollowUps = meeting.followUps ?? [];

    const result = await callModel({
      model,
      system,
      messages: [
        {
          role: 'user',
          content: buildFollowUpUserMessage(meeting, meetingTypes, meeting.transcript, previousFollowUps, question),
        },
      ],
      maxTokens: FOLLOW_UP_MAX_TOKENS,
      effort: 'medium',
      apiKey: clientApiKey,
    });

    const answer = result.refused ? 'הפרסונה סירבה לענות על השאלה הזו.' : result.text;

    const followUp: FollowUp = {
      id: randomUUID(),
      personaId,
      personaName,
      question,
      answer,
      usage: result.usage,
      createdAt: new Date().toISOString(),
    };

    const updatedUsage = {
      inputTokens: meeting.usage.inputTokens + result.usage.inputTokens,
      outputTokens: meeting.usage.outputTokens + result.usage.outputTokens,
      cacheReadTokens: meeting.usage.cacheReadTokens + result.usage.cacheReadTokens,
      apiCalls: meeting.usage.apiCalls + 1,
    };

    await updateMeeting(id, {
      followUps: [...previousFollowUps, followUp],
      usage: updatedUsage,
    });

    return NextResponse.json(followUp);
  } catch (err) {
    return internalError(err);
  }
}
