import { getMeeting } from '@/lib/store';
import { internalError, jsonError, validateId } from '../../../_lib/http';
import { renderMarkdown } from './render';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const idError = validateId(id);
  if (idError) return idError;
  const format = new URL(req.url).searchParams.get('format') ?? 'md';
  if (format !== 'md' && format !== 'json') {
    return jsonError('פורמט הייצוא חייב להיות md או json.', 400);
  }

  try {
    const meeting = await getMeeting(id);
    if (!meeting) return jsonError('הפגישה לא נמצאה.', 404);

    if (format === 'json') {
      const body = JSON.stringify(meeting, null, 2);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="virmeet-meeting-${id}.json"`,
        },
      });
    }

    const body = renderMarkdown(meeting);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="virmeet-meeting-${id}.md"`,
      },
    });
  } catch (err) {
    return internalError(err);
  }
}
