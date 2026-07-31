import { NextResponse } from 'next/server';
import { deleteUpload, getPersona, setPersonaFiles } from '@/lib/store';
import { internalError, jsonError, validateId } from '../../../../_lib/http';

interface RouteContext {
  params: Promise<{ id: string; fileId: string }>;
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const { id, fileId } = await params;
  const idError = validateId(id) ?? validateId(fileId);
  if (idError) return idError;
  try {
    const persona = await getPersona(id);
    if (!persona) return jsonError('המשתתף לא נמצא.', 404);

    await deleteUpload(id, fileId);
    const nextFiles = persona.files.filter((f) => f.id !== fileId);
    const updated = await setPersonaFiles(id, nextFiles);
    if (!updated) return jsonError('המשתתף לא נמצא.', 404);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError(err);
  }
}
