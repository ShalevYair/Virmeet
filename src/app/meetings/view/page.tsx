'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  meetingsApi,
  personasApi,
  runMeeting,
} from '@/lib/api-client';
import { downloadMeetingDocx, downloadMeetingJson, downloadMeetingMarkdown } from '@/lib/export';
import {
  UNASSIGNED_TASK_OWNER_FALLBACK,
  type Meeting,
  type MeetingPhase,
  type MeetingResult,
  type MeetingTask,
  type Persona,
  type TranscriptEntry,
} from '@/lib/types';
import { Badge, Button, Card, ErrorBanner, Skeleton, inputClasses } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PersonaAvatar } from '@/components/PersonaAvatar';
import { MeetingChat } from '@/components/MeetingChat';

const PHASE_ORDER: MeetingPhase[] = ['prep', 'opening', 'discussion', 'convergence', 'extraction'];
const PHASE_LABEL: Record<MeetingPhase, string> = {
  prep: 'הכנה',
  opening: 'פתיחה',
  discussion: 'דיון',
  convergence: 'התכנסות',
  extraction: 'משימות',
};

type ResultTab = 'tasks' | 'openQuestions' | 'decisions' | 'conflicts' | 'risks' | 'assumptions';

const RESULT_TABS: { id: ResultTab; label: string }[] = [
  { id: 'tasks', label: 'משימות' },
  { id: 'openQuestions', label: 'שאלות פתוחות' },
  { id: 'decisions', label: 'החלטות' },
  { id: 'conflicts', label: 'התנגשויות' },
  { id: 'risks', label: 'סיכונים' },
  { id: 'assumptions', label: 'הנחות שהמודל השלים' },
];

const PRIORITY_LABEL: Record<MeetingTask['priority'], string> = {
  high: 'עדיפות גבוהה',
  medium: 'עדיפות בינונית',
  low: 'עדיפות נמוכה',
};
const PRIORITY_TONE: Record<MeetingTask['priority'], 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const FACILITATOR_COLOR = '#334155';
const CREATOR_COLOR = '#7c3aed';

// A run whose engine died with its tab (closed mid-meeting) leaves the
// meeting stuck in 'running' forever — nothing else ever updates it. Chosen
// conservatively: a single high-effort model call can run past a minute, and
// the retry loop alone can add up to 14s, so this must clear real in-progress
// work by a wide margin. A false "stuck" banner on a meeting that's actually
// still running is worse than the current silence.
const STALE_RUNNING_MS = 3 * 60_000;

function DisclaimerBanner() {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl border-2 border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="mt-0.5 shrink-0"
      >
        <path d="M12 9v4M12 16.5h.01" strokeLinecap="round" />
        <path d="M10.3 3.9 2.6 17.5A1.8 1.8 0 004.2 20.2h15.6a1.8 1.8 0 001.6-2.7L13.7 3.9a1.8 1.8 0 00-3.4 0z" />
      </svg>
      <p className="font-medium leading-relaxed">
        הפלט הזה הוא הכנה לפגישה, לא תחליף לה. הדעות כאן נוצרו על ידי מודל שפה ואינן מייצגות את
        עמדתם של אנשים אמיתיים.
      </p>
    </div>
  );
}

function PhaseRail({ current, status }: { current: MeetingPhase; status: Meeting['status'] }) {
  const currentIndex = PHASE_ORDER.indexOf(current);
  const allDone = status === 'completed';
  return (
    <Card className="flex items-center gap-1 overflow-x-auto p-4">
      {PHASE_ORDER.map((phase, i) => {
        const isDone = allDone || i < currentIndex;
        const isCurrent = status === 'running' && i === currentIndex;
        const isFailedHere = status === 'failed' && i === currentIndex;
        const isCancelledHere = status === 'cancelled' && i === currentIndex;
        return (
          <div key={phase} className="flex flex-1 items-center gap-1">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  isFailedHere
                    ? 'bg-red-600 text-white'
                    : isCancelledHere
                      ? 'bg-amber-500 text-white'
                      : isCurrent
                        ? 'bg-blue-600 text-white'
                        : isDone
                          ? 'bg-emerald-600 text-white'
                          : 'bg-black/10 text-black/50 dark:bg-white/10 dark:text-white/50'
                }`}
              >
                {isDone && !isFailedHere && !isCancelledHere ? '✓' : i + 1}
              </div>
              <span
                className={`whitespace-nowrap text-xs ${
                  isCurrent || isFailedHere || isCancelledHere ? 'font-semibold' : 'text-black/55 dark:text-white/55'
                }`}
              >
                {PHASE_LABEL[phase]}
              </span>
            </div>
            {i < PHASE_ORDER.length - 1 && (
              <div
                className={`mx-1 h-0.5 flex-1 rounded-full ${
                  isDone ? 'bg-emerald-600' : 'bg-black/10 dark:bg-white/10'
                }`}
              />
            )}
          </div>
        );
      })}
    </Card>
  );
}

function TranscriptBubble({
  entry,
  personaById,
}: {
  entry: TranscriptEntry;
  personaById: Map<string, Persona>;
}) {
  if (entry.speakerId === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-black/5 px-3 py-1 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
          {entry.text}
        </span>
      </div>
    );
  }

  const isFacilitator = entry.speakerId === 'facilitator';
  const isCreator = entry.speakerId === 'creator';
  const persona = personaById.get(entry.speakerId);
  const color = isFacilitator ? FACILITATOR_COLOR : isCreator ? CREATOR_COLOR : persona?.color ?? '#64748b';
  const name = entry.speakerName || (isFacilitator ? 'מנחה' : isCreator ? 'אתה (יוצר הפגישה)' : 'דובר');

  return (
    <div className="flex gap-3">
      <PersonaAvatar name={name} color={color} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{name}</span>
          <Badge tone="neutral">{PHASE_LABEL[entry.phase]}</Badge>
          {typeof entry.round === 'number' && <Badge tone="neutral">סבב {entry.round}</Badge>}
          {entry.webSearches && entry.webSearches.length > 0 && (
            <Badge tone="info">
              🔎 חיפוש ברשת: {entry.webSearches.map((w) => w.query).join(', ')}
            </Badge>
          )}
        </div>
        <div
          className="mt-1.5 whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-black/10 bg-black/[0.02] p-3 text-sm leading-relaxed dark:border-white/10 dark:bg-white/[0.04]"
          style={{ borderInlineStartWidth: 3, borderInlineStartColor: color }}
        >
          {entry.text}
        </div>
      </div>
    </div>
  );
}

function UsagePanel({ usage }: { usage: Meeting['usage'] }) {
  const stats: { label: string; value: number }[] = [
    { label: 'קריאות API', value: usage.apiCalls },
    { label: 'טוקני קלט', value: usage.inputTokens },
    { label: 'טוקני פלט', value: usage.outputTokens },
    { label: 'טוקני קריאת cache', value: usage.cacheReadTokens },
    { label: 'טוקני כתיבת cache', value: usage.cacheWriteTokens },
  ];
  return (
    <Card className="flex flex-col gap-3 p-5">
      <h2 className="text-sm font-semibold">שימוש</h2>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col">
            <span className="text-xs text-black/55 dark:text-white/55">{s.label}</span>
            <span className="text-sm font-semibold tabular-nums">{s.value.toLocaleString('he-IL')}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TaskCard({ task }: { task: MeetingTask }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">{task.title}</p>
        <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge>
      </div>
      <p className="text-sm text-black/70 dark:text-white/70">{task.description}</p>
      {task.dependsOn.length > 0 && (
        <p className="text-xs text-black/50 dark:text-white/50">תלוי ב: {task.dependsOn.join(', ')}</p>
      )}
      <div className="mt-1 flex flex-col gap-1.5 rounded-lg bg-black/[0.03] p-3 text-xs dark:bg-white/[0.04]">
        <p>
          <span className="font-semibold">ההנחה: </span>
          {task.assumption}
        </p>
        <p className="text-amber-700 dark:text-amber-400">
          <span className="font-semibold">הסיכון אם ההנחה שגויה: </span>
          {task.riskIfAssumptionWrong}
        </p>
      </div>
    </Card>
  );
}

function ResultTabs({ result }: { result: MeetingResult }) {
  const [tab, setTab] = useState<ResultTab>('tasks');

  const groupedTasks = useMemo(() => {
    const map = new Map<string, MeetingTask[]>();
    for (const task of result.tasks) {
      const key = task.ownerName || UNASSIGNED_TASK_OWNER_FALLBACK;
      map.set(key, [...(map.get(key) ?? []), task]);
    }
    return Array.from(map.entries());
  }, [result.tasks]);

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">סיכום</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">{result.summary}</p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-black/10 pb-2 dark:border-white/10">
        {RESULT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-blue-600 text-white'
                : 'text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'tasks' &&
        (result.tasks.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">לא הופקו משימות.</p>
        ) : (
          <div className="flex flex-col gap-5">
            {groupedTasks.map(([owner, tasks]) => (
              <div key={owner} className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-black/70 dark:text-white/70">{owner}</h3>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {tasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === 'openQuestions' &&
        (result.openQuestions.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">אין שאלות פתוחות.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {result.openQuestions.map((q, i) => (
              <li
                key={i}
                className="flex flex-col gap-1 rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{q.question}</p>
                  {q.blocking && <Badge tone="danger">חוסם</Badge>}
                </div>
                <p className="text-xs text-black/55 dark:text-white/55">מי צריך לענות: {q.whoShouldAnswer}</p>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'decisions' &&
        (result.decisions.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">לא סוכמו החלטות.</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm">
            {result.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        ))}

      {tab === 'conflicts' &&
        (result.conflicts.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">לא זוהו התנגשויות.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {result.conflicts.map((c, i) => (
              <li key={i} className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
                <p className="font-medium">{c.topic}</p>
                <p className="mt-1 text-black/65 dark:text-white/65">{c.sides}</p>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'risks' &&
        (result.risks.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">לא זוהו סיכונים.</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm">
            {result.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ))}

      {tab === 'assumptions' &&
        (result.modelAssumptions.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">המודל לא סימן הנחות משלימות.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {result.modelAssumptions.map((a, i) => (
              <li
                key={i}
                className="rounded-lg bg-blue-500/5 px-3 py-2 text-sm text-blue-900 dark:bg-blue-400/10 dark:text-blue-200"
              >
                {a}
              </li>
            ))}
          </ul>
        ))}
    </Card>
  );
}

function MeetingRunInner({ id }: { id: string }) {
  const router = useRouter();

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentPhase, setCurrentPhase] = useState<MeetingPhase>('prep');
  const [status, setStatus] = useState<Meeting['status']>('draft');
  const [result, setResult] = useState<MeetingResult | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [usage, setUsage] = useState<Meeting['usage'] | null>(null);
  const [staleRunning, setStaleRunning] = useState(false);
  const [creatorTurnRequest, setCreatorTurnRequest] = useState<
    { round: number; totalRounds: number; resolve: (text: string) => void } | null
  >(null);
  const [creatorDraft, setCreatorDraft] = useState('');

  const hasStartedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks whether this tab actually watched the meeting run (as opposed to
  // just opening the results page of a meeting that finished long ago), so
  // the DOCX auto-download below fires exactly once per completed run.
  const wasLiveRef = useRef(false);
  const autoDownloadedRef = useRef(false);

  const personaById = useMemo(() => {
    const map = new Map<string, Persona>();
    for (const p of personas ?? []) map.set(p.id, p);
    return map;
  }, [personas]);

  const participants = useMemo(
    () => (meeting?.participantIds ?? []).map((pid) => personaById.get(pid)).filter((p): p is Persona => p != null),
    [meeting, personaById]
  );

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function applyMeeting(m: Meeting) {
    setMeeting(m);
    setTranscript(m.transcript);
    setStatus(m.status);
    setResult(m.result);
    setUsage(m.usage);
    if (m.transcript.length > 0) {
      setCurrentPhase(m.transcript[m.transcript.length - 1].phase);
    }
    if (m.status === 'failed' && m.error) {
      setRunError(m.error);
    }
  }

  function startPolling() {
    stopPolling();
    setStaleRunning(false);
    pollRef.current = setInterval(async () => {
      try {
        const fresh = await meetingsApi.get(id);
        applyMeeting(fresh);
        if (fresh.status !== 'running' && fresh.status !== 'draft') {
          stopPolling();
          return;
        }
        // The engine persists after every phase transition and every
        // transcript entry (runner.ts), so a 'running' meeting whose
        // updatedAt hasn't moved in a while almost certainly died with the
        // tab that was running it — nothing else will ever update it, so
        // polling forever would never resolve. Stop polling and let the user
        // decide (never flip status automatically: a second tab could
        // genuinely still be running this meeting).
        if (fresh.status === 'running' && Date.now() - new Date(fresh.updatedAt).getTime() > STALE_RUNNING_MS) {
          setStaleRunning(true);
          stopPolling();
        }
      } catch {
        // Transient error while polling — keep trying on the next tick.
      }
    }, 2500);
  }

  // Drives both the automatic first run (from the load effect below) and the
  // "הרץ שוב" button on a failed/cancelled meeting. `isRerun` resets the
  // local transcript/result/error/phase state first — api-client.runMeeting
  // already resets the *stored* transcript/usage before a re-run, but the
  // state here was populated from the old meeting by applyMeeting, and
  // onEntry only appends, so without this reset the UI would show the old
  // transcript followed by the new one even though storage never did.
  async function startRun(isRerun: boolean) {
    hasStartedRef.current = true;
    if (isRerun) {
      setTranscript([]);
      setResult(null);
      setRunError(null);
      setCurrentPhase('prep');
      setUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 });
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // A creator turn awaiting input must never hang forever if the run is
    // cancelled out from under it — resolve it with '' (skip) right away.
    controller.signal.addEventListener('abort', () => {
      setCreatorTurnRequest((prev) => {
        prev?.resolve('');
        return null;
      });
    });
    setStatus('running');
    await runMeeting(id, {
      signal: controller.signal,
      onCreatorTurn: (info) =>
        new Promise<string>((resolve) => {
          setCreatorDraft('');
          setCreatorTurnRequest({ ...info, resolve });
        }),
      onPhase: (phase) => {
        setCurrentPhase(phase);
        // TranscriptEntry.usage is populated per-line, but system lines carry
        // none and facilitator calls count toward total usage without
        // attaching it to an entry — summing from entries would undercount.
        // Storage has the true running total after every persist(), so pull
        // it fresh at each phase boundary instead.
        meetingsApi.get(id).then((m) => setUsage(m.usage)).catch(() => {});
      },
      onEntry: (entry) => setTranscript((prev) => [...prev, entry]),
      onDone: (res) => {
        setResult(res);
        setStatus('completed');
        stopPolling();
      },
      onError: (message) => {
        setRunError(message);
        setStatus('failed');
        stopPolling();
      },
      onCancelled: () => {
        setStatus('cancelled');
        stopPolling();
      },
    });
    // Stream ended without a terminal event — reconcile with IndexedDB
    // instead of guessing.
    const fresh = await meetingsApi.get(id).catch(() => null);
    if (fresh && (fresh.status === 'completed' || fresh.status === 'failed' || fresh.status === 'cancelled')) {
      applyMeeting(fresh);
    } else if (fresh && fresh.status === 'running') {
      applyMeeting(fresh);
      startPolling();
    }
  }

  async function handleRerun() {
    if (starting) return;
    setStarting(true);
    try {
      await startRun(true);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([meetingsApi.get(id), personasApi.list()])
      .then(([m, people]) => {
        if (cancelled) return;
        applyMeeting(m);
        setPersonas(people);

        if (m.status === 'draft' && !hasStartedRef.current) {
          void startRun(false);
        } else if (m.status === 'running') {
          // A run is already in progress in another tab, or this tab was
          // reloaded mid-run (the engine promise died with the old page) —
          // poll for updates and let the user cancel a stuck meeting below.
          startPolling();
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'טעינת הפגישה נכשלה');
      });

    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Warn before leaving the tab mid-run — the engine runs in this tab only,
  // so navigating away or closing it stops the meeting (spec §5.5).
  useEffect(() => {
    if (status !== 'running') return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [status]);

  useEffect(() => {
    if (status === 'running' || status === 'draft') {
      wasLiveRef.current = true;
    }
  }, [status]);

  // Downloads the DOCX summary automatically the moment a meeting this tab
  // was watching finishes running — not on every visit to an already-
  // completed meeting's page (guarded by wasLiveRef/autoDownloadedRef above).
  // Fetches the just-persisted record instead of merging local state: the
  // extraction-generated title (see engine/runner.ts) lands in storage
  // before the 'done' event fires, but local `meeting` state only picks it
  // up via a separate reconciliation step that can still be pending here.
  useEffect(() => {
    if (status !== 'completed' || !wasLiveRef.current || autoDownloadedRef.current) return;
    autoDownloadedRef.current = true;
    meetingsApi
      .get(id)
      .then((m) => downloadMeetingDocx(m, participants))
      .catch((err) => {
        console.error('הורדת סיכום הפגישה (DOCX) נכשלה', err);
      });
  }, [status, id, participants]);

  // After an additional discussion round finishes (MeetingChat), re-fetch the
  // just-persisted meeting so usage/discussionRounds — which the round
  // updates directly in storage — reflect it; the transcript itself is kept
  // live via onRoundEntry below instead of waiting for this refetch.
  function refreshAfterAdditionalRound() {
    meetingsApi.get(id).then((m) => {
      setUsage(m.usage);
      setMeeting(m);
    }).catch(() => {});
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      abortRef.current?.abort();
      stopPolling();
      const updated = await meetingsApi.update(id, { status: 'cancelled' });
      applyMeeting(updated);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : 'ביטול הפגישה נכשל');
    } finally {
      setCancelling(false);
      setCancelOpen(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <ErrorBanner message={loadError} onRetry={() => router.refresh()} />
        <Button variant="secondary" onClick={() => router.push('/meetings/')}>
          חזרה לרשימת הפגישות
        </Button>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const isLive = status === 'running' || status === 'draft';

  return (
    <div className="flex flex-col gap-6 pb-16">
      <DisclaimerBanner />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{meeting.title || 'פגישה חדשה (הכותרת תיקבע בסיום)'}</h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">{meeting.objective}</p>
        </div>
        <div className="flex items-center gap-2">
          {isLive && (
            <Button variant="danger" onClick={() => setCancelOpen(true)}>
              בטל פגישה
            </Button>
          )}
          {(status === 'failed' || status === 'cancelled') && (
            <Button variant="secondary" onClick={handleRerun} disabled={starting}>
              הרץ שוב
            </Button>
          )}
          {(status === 'completed' || status === 'failed' || status === 'cancelled') && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  downloadMeetingDocx(meeting, participants).catch((err) => console.error('ייצוא DOCX נכשל', err));
                }}
              >
                ייצוא DOCX
              </Button>
              <Button variant="secondary" onClick={() => downloadMeetingMarkdown(meeting, participants)}>
                ייצוא Markdown
              </Button>
              <Button
                variant="secondary"
                onClick={() => downloadMeetingJson(meeting, participants)}
              >
                ייצוא JSON
              </Button>
            </>
          )}
        </div>
      </div>

      <PhaseRail current={currentPhase} status={status} />

      {status === 'running' && staleRunning && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200">
          <span>
            נראה שהריצה נקטעה — לא התקבל עדכון מהפגישה זמן ארוך. ייתכן שהלשונית שהריצה אותה נסגרה. אפשר לבטל
            את הפגישה ולנסות שוב.
          </span>
          <Button variant="danger" onClick={() => setCancelOpen(true)} disabled={cancelling}>
            בטל פגישה
          </Button>
        </div>
      )}

      {status === 'running' && !staleRunning && (
        <div className="flex items-center gap-2 text-sm text-blue-700 dark:text-blue-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" />
          הפגישה מתקיימת כעת…
        </div>
      )}

      {status === 'cancelled' && (
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          הפגישה בוטלה על ידי המשתמש. התמליל שנוצר עד כה נשמר.
        </div>
      )}

      {runError && <ErrorBanner message={runError} />}

      {status !== 'draft' && usage && <UsagePanel usage={usage} />}

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold">תמליל הפגישה</h2>
        {transcript.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">התמליל עדיין ריק — הפגישה עומדת להתחיל.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {transcript.map((entry) => (
              <TranscriptBubble key={entry.id} entry={entry} personaById={personaById} />
            ))}
          </div>
        )}
      </Card>

      {creatorTurnRequest && (
        <Card className="flex flex-col gap-3 border-2 border-violet-500/40 p-5">
          <div>
            <h2 className="text-sm font-semibold">התור שלך — סבב {creatorTurnRequest.round} מתוך {creatorTurnRequest.totalRounds}</h2>
            <p className="mt-1 text-xs text-black/55 dark:text-white/55">
              המשתתפים סיימו את הסבב הזה. אפשר להוסיף מה שיש לך לומר, או לדלג.
            </p>
          </div>
          <textarea
            dir="rtl"
            autoFocus
            value={creatorDraft}
            onChange={(e) => setCreatorDraft(e.target.value)}
            style={{ minHeight: 100 }}
            className={inputClasses}
            placeholder="מה תרצה/י להוסיף לדיון בסבב הזה?"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                creatorTurnRequest.resolve('');
                setCreatorTurnRequest(null);
              }}
            >
              דלג
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                creatorTurnRequest.resolve(creatorDraft);
                setCreatorTurnRequest(null);
              }}
            >
              שלח
            </Button>
          </div>
        </Card>
      )}

      {status === 'completed' && result && <ResultTabs result={result} />}

      {status === 'completed' && meeting && participants.length > 0 && (
        <MeetingChat
          key={meeting.id}
          meetingId={meeting.id}
          participants={participants}
          initialChat={meeting.chat}
          onRoundEntry={(entry) => setTranscript((prev) => [...prev, entry])}
          onRoundComplete={refreshAfterAdditionalRound}
        />
      )}

      <ConfirmDialog
        open={cancelOpen}
        title="לבטל את הפגישה?"
        description="הפגישה תופסק ולא תושלם. התמליל שנוצר עד כה יישמר."
        confirmLabel="בטל פגישה"
        busy={cancelling}
        onConfirm={handleCancel}
        onCancel={() => setCancelOpen(false)}
      />
    </div>
  );
}

function MeetingRunSearchParams() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  return <MeetingRunInner id={id} />;
}

export default function MeetingRunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
          <Skeleton className="h-64" />
        </div>
      }
    >
      <MeetingRunSearchParams />
    </Suspense>
  );
}
