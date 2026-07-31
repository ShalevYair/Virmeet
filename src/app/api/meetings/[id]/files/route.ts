import { NextResponse } from 'next/server';
import { deleteUpload, getMeeting, saveUpload, setMeetingFiles } from '@/lib/store';
import { internalError, jsonError, validateId } from '../../../_lib/http';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;
  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);
    if (meeting.status !== 'draft') {
      return jsonError('לא ניתן להוסיף קבצי רקע לפגישה שכבר החלה לרוץ או הסתיימה.', 400);
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError('הבקשה חייבת להיות multipart/form-data עם שדה file.', 400);
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return jsonError('לא צורף קובץ (שדה file חסר).', 400);
    }

    let attached;
    try {
      attached = await saveUpload(id, file);
    } catch (uploadErr) {
      return jsonError(uploadErr instanceof Error ? uploadErr.message : 'העלאת הקובץ נכשלה.', 400);
    }

    const updated = await setMeetingFiles(id, [...meeting.files, attached]);
    if (!updated) return jsonError('הפגישה לא נמצאה.', 404);
    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}

export async function DELETE(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const fileId = new URL(req.url).searchParams.get('fileId');
  if (!fileId) return jsonError('חסר פרמטר fileId.', 400);
  const idError = validateId(id) ?? validateId(fileId);
  if (idError) return idError;

  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);

    await deleteUpload(id, fileId);
    const nextFiles = meeting.files.filter((f) => f.id !== fileId);
    const updated = await setMeetingFiles(id, nextFiles);
    if (!updated) return jsonError('הפגישה לא נמצאה.', 404);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError(err);
  }
}
