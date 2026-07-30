import { NextResponse } from 'next/server';
import { createMeetingType, listMeetingTypes } from '@/lib/store';
import { internalError, parseJsonBody } from '../_lib/http';
import { meetingTypeCreateSchema } from '../_lib/schemas';

export async function GET() {
  try {
    const types = await listMeetingTypes();
    return NextResponse.json(types);
  } catch (err) {
    return internalError(err);
  }
}

export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, meetingTypeCreateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const meetingType = await createMeetingType(parsed.data);
    return NextResponse.json(meetingType, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}
