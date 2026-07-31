import { NextResponse } from 'next/server';
import { getPersona, saveUpload, setPersonaFiles } from '@/lib/store';
import { internalError, jsonError, validateId } from '../../../_lib/http';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;
  try {
    const persona = await getPersona(id);
    if (!persona) return jsonError('המשתתף לא נמצא.', 404);

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
      // saveUpload's thrown errors are already Hebrew, user-facing validation
      // messages (file too large / unsupported type / bad path) — 400, not 500.
      return jsonError(uploadErr instanceof Error ? uploadErr.message : 'העלאת הקובץ נכשלה.', 400);
    }

    const updated = await setPersonaFiles(id, [...persona.files, attached]);
    if (!updated) return jsonError('המשתתף לא נמצא.', 404);
    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}
