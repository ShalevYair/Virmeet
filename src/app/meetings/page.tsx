'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, MeetingSummary, meetingsApi } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBanner, Skeleton } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';

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

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MeetingSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function load() {
    setError(null);
    meetingsApi
      .list()
      .then(setMeetings)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'טעינת הפגישות נכשלה'));
  }

  useEffect(load, []);

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await meetingsApi.remove(pendingDelete.id);
      setMeetings((prev) => prev?.filter((m) => m.id !== pendingDelete.id) ?? prev);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'מחיקת הפגישה נכשלה');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">פגישות</h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            כל סימולציות הפגישה — טיוטות, פגישות פעילות והושלמות.
          </p>
        </div>
        <Link href="/meetings/new">
          <Button variant="primary">+ פגישה חדשה</Button>
        </Link>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {meetings === null ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : meetings.length === 0 ? (
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
          {meetings.map((m) => (
            <Card key={m.id} className="flex items-center justify-between gap-4 p-4">
              <Link href={`/meetings/${m.id}`} className="min-w-0 flex-1">
                <p className="truncate font-medium">{m.title || 'פגישה ללא כותרת'}</p>
                <p className="mt-0.5 truncate text-xs text-black/55 dark:text-white/55">
                  {m.objective || 'ללא תיאור מטרה'}
                </p>
              </Link>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-black/50 dark:text-white/50">{formatDate(m.createdAt)}</span>
                <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                <Button
                  variant="ghost"
                  className="text-red-600 dark:text-red-400"
                  onClick={() => setPendingDelete(m)}
                >
                  מחק
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`למחוק את "${pendingDelete?.title || 'הפגישה'}"?`}
        description={
          <>
            הפעולה תמחק לצמיתות את הפגישה, כולל התמליל והתוצאות שלה. לא ניתן לבטל פעולה זו.
            {deleteError && <p className="mt-2 text-red-600 dark:text-red-400">{deleteError}</p>}
          </>
        }
        confirmLabel="מחק לצמיתות"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
