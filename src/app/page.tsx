'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, MeetingSummary, meetingsApi } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBanner, Skeleton } from '@/components/ui';

const STATUS_LABEL: Record<MeetingSummary['status'], string> = {
  draft: 'טיוטה',
  running: 'רצה כעת',
  completed: 'הושלמה',
  failed: 'נכשלה',
  cancelled: 'בוטלה',
};

const STATUS_TONE: Record<MeetingSummary['status'], 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral',
  running: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function DashboardPage() {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    meetingsApi
      .list()
      .then(setMeetings)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'טעינת הפגישות נכשלה'));
  }

  useEffect(load, []);

  const recent = meetings?.slice(0, 8) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">לוח מחוונים</h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            סימולציית פגישות רב-משתתפים — הכנה לדיון אמיתי, לא תחליף לו.
          </p>
        </div>
        <Link href="/meetings/new">
          <Button variant="primary">+ פגישה חדשה</Button>
        </Link>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">פגישות אחרונות</h2>
        {meetings && meetings.length > 8 && (
          <Link href="/meetings" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            כל הפגישות ←
          </Link>
        )}
      </div>

      {meetings === null ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          title="עדיין אין פגישות"
          description="התחילו פגישת סימולציה ראשונה כדי לראות כאן תמליל, משימות והחלטות."
          action={
            <Link href="/meetings/new">
              <Button variant="primary">+ פגישה חדשה</Button>
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {recent.map((m) => (
            <Link key={m.id} href={`/meetings/${m.id}`}>
              <Card className="flex items-center justify-between gap-4 p-4 transition-shadow hover:shadow-md">
                <div className="min-w-0">
                  <p className="truncate font-medium">{m.title || 'פגישה ללא כותרת'}</p>
                  <p className="mt-0.5 truncate text-xs text-black/55 dark:text-white/55">
                    {m.objective || 'ללא תיאור מטרה'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-black/50 dark:text-white/50">{formatDate(m.createdAt)}</span>
                  <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
