'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, healthApi, meetingTypesApi, meetingsApi, personasApi } from '@/lib/api-client';
import { AVAILABLE_MODELS, DEFAULT_MODEL, type AvailableModel, type MeetingType, type Persona } from '@/lib/types';
import { Badge, Button, Card, ErrorBanner, Field, Skeleton, inputClasses } from '@/components/ui';
import { PersonaAvatar } from '@/components/PersonaAvatar';
import { getStoredApiKey } from '@/lib/api-key';

const MODEL_LABELS: Record<AvailableModel, { title: string; hint: string }> = {
  'gemini-pro-latest': { title: 'Gemini Pro', hint: 'הכי חזק — לדיונים מורכבים שדורשים איכות מקסימלית' },
  'gemini-flash-latest': { title: 'Gemini Flash', hint: 'מאוזן — מהירות וידה מול איכות (ברירת מחדל)' },
  'gemini-flash-lite-latest': { title: 'Gemini Flash-Lite', hint: 'הכי מהיר וזול — לפגישות עם הרבה משתתפים/סבבים' },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} בייט`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function NewMeetingPage() {
  const router = useRouter();

  const [meetingTypes, setMeetingTypes] = useState<MeetingType[] | null>(null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [selectedTypeIds, setSelectedTypeIds] = useState<string[]>([]);
  const [objective, setObjective] = useState('');
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [model, setModel] = useState<AvailableModel>(DEFAULT_MODEL);
  const [discussionRounds, setDiscussionRounds] = useState(2);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const [hasBrowserKey, setHasBrowserKey] = useState(true);
  const [serverKeyConfigured, setServerKeyConfigured] = useState(true);

  function load() {
    setLoadError(null);
    Promise.all([meetingTypesApi.list(), personasApi.list()])
      .then(([types, people]) => {
        setMeetingTypes(types);
        setPersonas(people);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'טעינת הנתונים נכשלה'));
  }

  useEffect(load, []);

  useEffect(() => {
    setHasBrowserKey(Boolean(getStoredApiKey()));
    healthApi
      .get()
      .then((res) => setServerKeyConfigured(res.serverKeyConfigured))
      .catch(() => setServerKeyConfigured(true)); // fail open — don't nag if the health check itself fails
  }, []);

  const missingApiKey = !serverKeyConfigured && !hasBrowserKey;

  const activePersonas = useMemo(() => (personas ?? []).filter((p) => p.isActive), [personas]);

  function toggleType(id: string) {
    setSelectedTypeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleParticipant(id: string) {
    setParticipantIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    setStagedFiles((prev) => [...prev, ...Array.from(fileList)]);
  }

  function removeStagedFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  const titleValid = title.trim().length > 0;
  const typesValid = selectedTypeIds.length >= 1;
  const participantsValid = participantIds.length >= 2;
  const formValid = titleValid && typesValid && participantsValid;

  async function handleStart() {
    setTouched(true);
    if (!formValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const meeting = await meetingsApi.create({
        title: title.trim(),
        meetingTypeIds: selectedTypeIds,
        objective,
        participantIds,
        model,
        discussionRounds,
      });
      for (const file of stagedFiles) {
        await meetingsApi.uploadFile(meeting.id, file);
      }
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'יצירת הפגישה נכשלה');
      setSubmitting(false);
    }
  }

  if (loadError) {
    return <ErrorBanner message={loadError} onRetry={load} />;
  }

  if (meetingTypes === null || personas === null) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-20">
      <div>
        <h1 className="text-2xl font-semibold">פגישה חדשה</h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          הגדירו את מטרת הפגישה, בחרו משתתפים, ולחצו &quot;התחל פגישה&quot; כדי להריץ את הסימולציה.
        </p>
      </div>

      {submitError && <ErrorBanner message={submitError} />}

      <Card className="flex flex-col gap-4 p-5">
        <Field label="כותרת הפגישה">
          <input
            className={inputClasses}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="לדוגמה: סקירת ארכיטקטורה — מערכת רישוי דיגיטלי"
          />
          {touched && !titleValid && <p className="text-xs text-red-600 dark:text-red-400">נדרשת כותרת</p>}
        </Field>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">סוג/י מטרת הפגישה</h2>
          <span className="text-xs text-black/50 dark:text-white/50">ניתן לבחור יותר מאחד</span>
        </div>
        {touched && !typesValid && (
          <p className="text-xs text-red-600 dark:text-red-400">יש לבחור לפחות סוג פגישה אחד</p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {meetingTypes.map((t) => {
            const selected = selectedTypeIds.includes(t.id);
            return (
              <button key={t.id} type="button" onClick={() => toggleType(t.id)} className="text-right">
                <Card
                  className={`flex h-full flex-col gap-1.5 p-4 transition-shadow hover:shadow-md ${
                    selected ? 'ring-2 ring-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold">{t.title}</p>
                    {selected && <Badge tone="info">נבחר</Badge>}
                  </div>
                  <p className="text-sm text-black/60 dark:text-white/60">{t.shortDescription}</p>
                </Card>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <Field label="מה רוצים להשיג / מה בונים" hint="תיאור חופשי של הפרויקט או ההחלטה שעל הפרק">
          <textarea
            dir="rtl"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            style={{ minHeight: 140 }}
            className={inputClasses}
            placeholder="לדוגמה: אנחנו בונים מערכת רישוי דיגיטלית חדשה שמחליפה תהליך ידני..."
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">משתתפים</h2>
          <span className="text-xs text-black/50 dark:text-white/50">נדרשים לפחות 2</span>
        </div>
        {touched && !participantsValid && (
          <p className="text-xs text-red-600 dark:text-red-400">יש לבחור לפחות שני משתתפים</p>
        )}
        {activePersonas.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">
            אין משתתפים פעילים. הוסיפו משתתפים בעמוד{' '}
            <a href="/personas" className="text-blue-600 hover:underline dark:text-blue-400">
              משתתפים
            </a>
            .
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activePersonas.map((p) => {
              const selected = participantIds.includes(p.id);
              return (
                <button key={p.id} type="button" onClick={() => toggleParticipant(p.id)} className="text-right">
                  <Card
                    className={`flex items-center gap-3 p-3 transition-shadow hover:shadow-md ${
                      selected ? 'ring-2 ring-blue-500' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleParticipant(p.id)}
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <PersonaAvatar name={p.name} color={p.color} size={36} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="truncate text-xs text-black/55 dark:text-white/55">{p.role}</p>
                    </div>
                  </Card>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold">קבצי רקע משותפים</h2>
        <p className="text-xs text-black/50 dark:text-white/50">
          קבצים אלה יוזרקו לכל המשתתפים בפגישה. הם יועלו בפועל כשמתחילים את הפגישה.
        </p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => document.getElementById('shared-file-input')?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
            dragging ? 'border-blue-500 bg-blue-500/5' : 'border-black/15 hover:border-black/30 dark:border-white/15 dark:hover:border-white/30'
          }`}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-black/40 dark:text-white/40">
            <path d="M12 16V4M12 4l-4 4M12 4l4 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-sm font-medium">גררו קבצים לכאן או לחצו לבחירה</p>
          <p className="text-xs text-black/50 dark:text-white/50">txt, md, csv, json, pdf, docx — עד 10MB לקובץ</p>
          <input
            id="shared-file-input"
            type="file"
            multiple
            accept=".txt,.md,.csv,.json,.pdf,.docx"
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>
        {stagedFiles.length > 0 && (
          <ul className="flex flex-col gap-2">
            {stagedFiles.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-sm dark:border-white/10 dark:bg-white/[0.03]"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="text-xs text-black/50 dark:text-white/50">{formatBytes(f.size)}</span>
                </div>
                <Button
                  variant="ghost"
                  className="shrink-0 !px-2 !py-1 text-red-600 dark:text-red-400"
                  onClick={() => removeStagedFile(i)}
                >
                  הסר
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold">מודל</h2>
        <p className="text-xs text-black/50 dark:text-white/50">
          המודל שישמש את כל המשתתפים והמנחה בפגישה הזו.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {AVAILABLE_MODELS.map((m) => {
            const selected = model === m;
            const label = MODEL_LABELS[m];
            return (
              <button key={m} type="button" onClick={() => setModel(m)} className="text-right">
                <Card
                  className={`flex h-full flex-col gap-1 p-4 transition-shadow hover:shadow-md ${
                    selected ? 'ring-2 ring-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold">{label.title}</p>
                    {selected && <Badge tone="info">נבחר</Badge>}
                  </div>
                  <p className="text-sm text-black/60 dark:text-white/60">{label.hint}</p>
                </Card>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold">מספר סבבי דיון</h2>
        <div className="flex gap-2">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setDiscussionRounds(n)}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border text-sm font-medium transition-colors ${
                discussionRounds === n
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-black/15 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </Card>

      {missingApiKey && (
        <ErrorBanner
          message={
            'לא נמצא מפתח API של Gemini — לא בשרת ולא בדפדפן הזה. הריצה תיכשל. יש להגדיר מפתח במסך ההגדרות לפני התחלת הפגישה.'
          }
        />
      )}
      {missingApiKey && (
        <p className="-mt-4 text-sm">
          <a href="/settings" className="text-blue-600 hover:underline dark:text-blue-400">
            מעבר להגדרות כדי להזין מפתח API
          </a>
        </p>
      )}

      <div className="sticky bottom-4 flex justify-end">
        <Card className="flex items-center gap-3 p-3 shadow-lg">
          <Button variant="primary" onClick={handleStart} disabled={submitting}>
            {submitting ? 'מתחיל פגישה…' : 'התחל פגישה'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
