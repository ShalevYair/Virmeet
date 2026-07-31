// Virmeet — POST /api/meetings/[id]/run: kicks off the meeting engine and
// streams progress back as Server-Sent Events (spec §4, §5).
//
// Event shapes are fixed by the spec and the UI is coded against them:
//   {type:'phase',phase} | {type:'entry',entry} | {type:'done',result} | {type:'error',message}

import { getMeeting } from '@/lib/store';
import { runMeeting } from '@/lib/engine/runner';
import { MeetingEvent } from '@/lib/engine/types';
import { jsonError, requireApiKey } from '../../../_lib/http';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;

  // Personal key pasted into Settings (client component) and sent only on
  // this request — never logged, never persisted (see runMeeting/store).
  const clientApiKey = req.headers.get('x-anthropic-api-key') || undefined;

  const apiKeyError = requireApiKey(clientApiKey);
  if (apiKeyError) return apiKeyError;

  const meeting = await getMeeting(id);
  if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);
  if (meeting.status === 'running') {
    return jsonError('הפגישה כבר רצה כעת.', 409);
  }
  if (meeting.status === 'completed') {
    return jsonError('הפגישה כבר הושלמה — אי אפשר להריץ אותה שוב.', 409);
  }
  if (meeting.status === 'cancelled') {
    return jsonError('הפגישה בוטלה — אי אפשר להריץ אותה שוב.', 409);
  }
  if (meeting.participantIds.length < 2) {
    return jsonError('נדרשים לפחות שני משתתפים כדי להריץ את הפגישה.', 400);
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

      try {
        await runMeeting(id, send, {}, clientApiKey);
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'שגיאה לא צפויה בהרצת הפגישה.',
        });
      } finally {
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
