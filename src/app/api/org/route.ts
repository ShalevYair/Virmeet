import { NextResponse } from 'next/server';
import { getOrgSettings, updateOrgSettings } from '@/lib/store';
import { internalError, parseJsonBody } from '../_lib/http';
import { orgUpdateSchema } from '../_lib/schemas';

export async function GET() {
  try {
    const settings = await getOrgSettings();
    return NextResponse.json(settings);
  } catch (err) {
    return internalError(err);
  }
}

export async function PATCH(req: Request) {
  const parsed = await parseJsonBody(req, orgUpdateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const updated = await updateOrgSettings(parsed.data);
    return NextResponse.json(updated);
  } catch (err) {
    return internalError(err);
  }
}
