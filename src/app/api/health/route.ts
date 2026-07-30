// Virmeet — GET /api/health: tells the client whether the server already has
// an Anthropic and/or Gemini key configured, so the "new meeting" screen can
// warn up front instead of after the user fills in the whole form. Never
// returns the keys themselves or any part of them — only booleans.

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
}
