import { NextResponse } from 'next/server';
import { deleteMeeting, getMeeting, listMeetingTypes, listPersonas, updateMeeting } from '@/lib/store';
import { internalError, jsonError, parseJsonBody } from '../../_lib/http';
import { meetingUpdateSchema } from '../../_lib/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);
    return NextResponse.json(meeting);
  } catch (err) {
    return internalError(err);
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const parsed = await parseJsonBody(req, meetingUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const patch = parsed.data;

  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);

    const editingContentFields = Object.keys(patch).some((k) => k !== 'status');
    if (editingContentFields && meeting.status !== 'draft') {
      return jsonError('לא ניתן לערוך פגישה שכבר החלה לרוץ או הסתיימה.', 400);
    }
    if (patch.status === 'cancelled' && meeting.status === 'completed') {
      return jsonError('לא ניתן לבטל פגישה שכבר הושלמה.', 400);
    }

    if (patch.participantIds || patch.meetingTypeIds) {
      const [personas, meetingTypes] = await Promise.all([listPersonas(), listMeetingTypes()]);
      const personaIds = new Set(personas.map((p) => p.id));
      const meetingTypeIdSet = new Set(meetingTypes.map((t) => t.id));
      const unknownParticipant = patch.participantIds?.find((pid) => !personaIds.has(pid));
      if (unknownParticipant) {
        return jsonError(`המשתתף שנבחר (${unknownParticipant}) אינו קיים.`, 400);
      }
      const unknownType = patch.meetingTypeIds?.find((tid) => !meetingTypeIdSet.has(tid));
      if (unknownType) {
        return jsonError(`סוג הפגישה שנבחר (${unknownType}) אינו קיים.`, 400);
      }
    }

    const updated = await updateMeeting(id, patch);
    if (!updated) return jsonError('הפגישה לא נמצאה.', 404);
    return NextResponse.json(updated);
  } catch (err) {
    return internalError(err);
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  try {
    const removed = await deleteMeeting(id);
    if (!removed) return jsonError('הפגישה לא נמצאה.', 404);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError(err);
  }
}
