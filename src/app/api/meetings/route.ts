import { NextResponse } from 'next/server';
import { createMeeting, listMeetings, listMeetingTypes, listPersonas } from '@/lib/store';
import { internalError, jsonError, parseJsonBody } from '../_lib/http';
import { meetingCreateSchema } from '../_lib/schemas';

export async function GET() {
  try {
    const meetings = await listMeetings(true);
    return NextResponse.json(meetings);
  } catch (err) {
    return internalError(err);
  }
}

export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, meetingCreateSchema);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  try {
    const [personas, meetingTypes] = await Promise.all([listPersonas(), listMeetingTypes()]);
    const personaIds = new Set(personas.map((p) => p.id));
    const meetingTypeIdSet = new Set(meetingTypes.map((t) => t.id));

    const unknownParticipant = input.participantIds.find((id) => !personaIds.has(id));
    if (unknownParticipant) {
      return jsonError(`המשתתף שנבחר (${unknownParticipant}) אינו קיים.`, 400);
    }
    const unknownType = input.meetingTypeIds.find((id) => !meetingTypeIdSet.has(id));
    if (unknownType) {
      return jsonError(`סוג הפגישה שנבחר (${unknownType}) אינו קיים.`, 400);
    }

    const meeting = await createMeeting(input);
    return NextResponse.json(meeting, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}
