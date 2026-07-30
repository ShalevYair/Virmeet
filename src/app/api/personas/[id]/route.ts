import { NextResponse } from 'next/server';
import { deletePersona, getPersona, updatePersona } from '@/lib/store';
import { internalError, jsonError, parseJsonBody } from '../../_lib/http';
import { personaUpdateSchema } from '../../_lib/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  try {
    const persona = await getPersona(id);
    if (!persona) return jsonError('המשתתף לא נמצא.', 404);
    return NextResponse.json(persona);
  } catch (err) {
    return internalError(err);
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const parsed = await parseJsonBody(req, personaUpdateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const updated = await updatePersona(id, parsed.data);
    if (!updated) return jsonError('המשתתף לא נמצא.', 404);
    return NextResponse.json(updated);
  } catch (err) {
    return internalError(err);
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  try {
    const removed = await deletePersona(id);
    if (!removed) return jsonError('המשתתף לא נמצא.', 404);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError(err);
  }
}
