import { NextResponse } from 'next/server';
import { deleteMeetingType, getMeetingType, updateMeetingType } from '@/lib/store';
import { internalError, jsonError, parseJsonBody, validateId } from '../../_lib/http';
import { meetingTypeUpdateSchema } from '../../_lib/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;
  try {
    const meetingType = await getMeetingType(id);
    if (!meetingType) return jsonError('סוג הפגישה לא נמצא.', 404);
    return NextResponse.json(meetingType);
  } catch (err) {
    return internalError(err);
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;
  const parsed = await parseJsonBody(req, meetingTypeUpdateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const updated = await updateMeetingType(id, parsed.data);
    if (!updated) return jsonError('סוג הפגישה לא נמצא.', 404);
    return NextResponse.json(updated);
  } catch (err) {
    return internalError(err);
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;
  try {
    const removed = await deleteMeetingType(id);
    if (!removed) return jsonError('סוג הפגישה לא נמצא.', 404);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && err.message.includes('מובנה')) {
      return jsonError(err.message, 400);
    }
    return internalError(err);
  }
}
