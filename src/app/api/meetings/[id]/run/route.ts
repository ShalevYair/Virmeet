// Virmeet — POST /api/meetings/[id]/run: kicks off the meeting engine and
// streams progress back as Server-Sent Events (spec §4, §5).
//
// Event shapes are fixed by the spec and the UI is coded against them:
//   {type:'phase',phase} | {type:'entry',entry} | {type:'done',result} | {type:'error',message}

import { getMeeting, updateMeeting } from '@/lib/store';
import { runMeeting } from '@/lib/engine/runner';
import { MeetingEvent } from '@/lib/engine/types';
import { registerRun, unregisterRun } from '@/lib/engine/run-registry';
import { jsonError, requireApiKey } from '../../../_lib/http';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// A meeting stuck in 'running' for longer than this (no transcript activity
// updating `updatedAt`) is treated as abandoned by a dead process, not as a
// live run — see P1.3.
const STALE_RUN_MS = 5 * 60_000;

function isStaleRun(updatedAt: string): boolean {
  return Date.now() - Date.parse(updatedAt) > STALE_RUN_MS;
}

// SSE heartbeat: a long, quiet `prep` phase (multiple personas + web search)
// can run for minutes with no transcript event. Reverse proxies close idle
// SSE connections after 30-60s, so we write a comment line every 15s — the
// client parser only reads lines starting with `data:` and ignores this.
const HEARTBEAT_MS = 15_000;

export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;

  // Personal key pasted into Settings (client component) and sent only on
  // this request — never logged, never persisted (see runMeeting/store).
  const clientApiKey = req.headers.get('x-anthropic-api-key') || undefined;

  const apiKeyError = requireApiKey(clientApiKey);
  if (apiKeyError) return apiKeyError;

  const meeting = await getMeeting(id);
  if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);
  if (meeting.status === 'completed') {
    return jsonError('הפגישה כבר הושלמה — אי אפשר להריץ אותה שוב.', 409);
  }
  if (meeting.status === 'running' && !isStaleRun(meeting.updatedAt)) {
    return jsonError('הפגישה כבר רצה כעת.', 409);
  }
  if (meeting.participantIds.length < 2) {
    return jsonError('נדרשים לפחות שני משתתפים כדי להריץ את הפגישה.', 400);
  }

  // Re-running a draft/failed/cancelled/stale meeting starts a fresh run:
  // the previous transcript and result are discarded, not appended to.
  if (meeting.status !== 'draft') {
    await updateMeeting(id, {
      transcript: [],
      result: null,
      error: null,
      completedAt: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: MeetingEvent): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Controller already closed (client disconnected) — drop the event.
        }
      }

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          // Controller already closed — the interval is cleared in finally.
        }
      }, HEARTBEAT_MS);

      // Lets PATCH /api/meetings/[id] (status:'cancelled') abort this exact
      // in-flight call immediately when it lands in the same process.
      const abortController = new AbortController();
      registerRun(id, abortController);

      try {
        await runMeeting(id, send, {}, clientApiKey, abortController.signal);
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'שגיאה לא צפויה בהרצת הפגישה.',
        });
      } finally {
        clearInterval(heartbeat);
        unregisterRun(id);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      // Client disconnected mid-stream. runMeeting() keeps running to
      // completion in the background and persists to disk regardless — the
      // UI falls back to polling GET /api/meetings/[id] per api-client.ts.
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
