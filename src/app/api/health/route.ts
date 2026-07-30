// Virmeet — GET /api/health: tells the client whether the server already has
// an Anthropic key configured, so the "new meeting" screen can warn up front
// instead of after the user fills in the whole form. Never returns the key
// itself or any part of it — only a boolean.

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ serverKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
}
