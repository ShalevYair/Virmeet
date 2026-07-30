import { NextResponse } from 'next/server';
import { createPersona, listPersonas } from '@/lib/store';
import { internalError, parseJsonBody } from '../_lib/http';
import { personaCreateSchema } from '../_lib/schemas';

export async function GET() {
  try {
    const personas = await listPersonas();
    return NextResponse.json(personas);
  } catch (err) {
    return internalError(err);
  }
}

export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, personaCreateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const persona = await createPersona(parsed.data);
    return NextResponse.json(persona, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}
