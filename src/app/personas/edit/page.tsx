'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, personasApi } from '@/lib/api-client';
import { exportPersonaToFile } from '@/lib/persona-io';
import { ANTHROPIC_MODELS, GEMINI_MODELS, type Persona } from '@/lib/types';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Skeleton,
  Toggle,
  inputClasses,
} from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FileUploader } from '@/components/FileUploader';
import { PersonaAvatar } from '@/components/PersonaAvatar';

const COLOR_SWATCHES = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#be185d',
  '#4d7c0f',
  '#475569',
];

function PersonaEditorInner({ id }: { id: string }) {
  const router = useRouter();

  const [persona, setPersona] = useState<Persona | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function load() {
    setLoadError(null);
    setPersona(null);
    personasApi
      .get(id)
      .then(setPersona)
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : 'טעינת המשתתף נכשלה')
      );
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id]);

  function update<K extends keyof Persona>(key: K, value: Persona[K]) {
    setPersona((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }

  async function handleSave() {
    if (!persona) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await personasApi.update(persona.id, {
        name: persona.name,
        role: persona.role,
        organization: persona.organization,
        color: persona.color,
        prompt: persona.prompt,
        model: persona.model,
        webAccess: persona.webAccess,
        maxApiCalls: persona.maxApiCalls,
        maxWebSearches: persona.maxWebSearches,
        isActive: persona.isActive,
      });
      setPersona(updated);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'שמירת המשתתף נכשלה');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!persona) return;
    setDeleting(true);
    setSaveError(null);
    try {
      await personasApi.remove(persona.id);
      router.push('/personas/');
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'מחיקת המשתתף נכשלה');
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  async function handleUpload(file: File) {
    if (!persona) return;
    await personasApi.uploadFile(persona.id, file);
    const refreshed = await personasApi.get(persona.id);
    setPersona(refreshed);
  }

  async function handleDeleteFile(fileId: string) {
    if (!persona) return;
    await personasApi.deleteFile(persona.id, fileId);
    const refreshed = await personasApi.get(persona.id);
    setPersona(refreshed);
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <ErrorBanner message={loadError} onRetry={load} />
        <Button variant="secondary" onClick={() => router.push('/personas/')}>
          חזרה לרשימת המשתתפים
        </Button>
      </div>
    );
  }

  if (!persona) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-16">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <PersonaAvatar name={persona.name || '?'} color={persona.color} size={48} />
          <div>
            <h1 className="text-xl font-semibold">{persona.name || 'משתתף חדש'}</h1>
            <p className="text-sm text-black/55 dark:text-white/55">{persona.role || 'ללא תפקיד'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
          <Button variant="secondary" onClick={() => exportPersonaToFile(persona)}>
            ייצוא JSON
          </Button>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            מחק משתתף
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'שומר…' : 'שמור שינויים'}
          </Button>
        </div>
      </div>

      {saveError && <ErrorBanner message={saveError} />}

      <Card className="flex flex-col gap-4 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="שם">
            <input
              className={inputClasses}
              value={persona.name}
              onChange={(e) => update('name', e.target.value)}
            />
          </Field>
          <Field label="תפקיד">
            <input
              className={inputClasses}
              value={persona.role}
              onChange={(e) => update('role', e.target.value)}
            />
          </Field>
          <Field label="ארגון / אגף" hint="לדוגמה: אגף טכנולוגיות, משרד התחבורה">
            <input
              className={inputClasses}
              value={persona.organization}
              onChange={(e) => update('organization', e.target.value)}
            />
          </Field>
          <Field label="פעיל" hint="משתתפים לא פעילים לא יוצעו ביצירת פגישה חדשה">
            <div className="flex items-center gap-3 pt-1">
              <Toggle checked={persona.isActive} onChange={(v) => update('isActive', v)} label="פעיל" />
              <span className="text-sm">{persona.isActive ? 'פעיל' : 'לא פעיל'}</span>
            </div>
          </Field>
        </div>

        <Field label="צבע אווטאר">
          <div className="flex flex-wrap items-center gap-2">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`בחר צבע ${c}`}
                onClick={() => update('color', c)}
                className={`h-7 w-7 rounded-full ring-offset-2 transition-shadow ${
                  persona.color === c ? 'ring-2 ring-black dark:ring-white' : ''
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input
              type="color"
              value={persona.color}
              onChange={(e) => update('color', e.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-black/15 bg-transparent dark:border-white/15"
              aria-label="צבע מותאם אישית"
            />
          </div>
        </Field>
      </Card>

      <Card className="flex flex-col gap-2 p-5">
        <div className="flex items-center justify-between">
          <label htmlFor="persona-prompt" className="text-sm font-medium">
            הפרומפט של הפרסונה
          </label>
          <span className="text-xs text-black/50 dark:text-white/50">
            {persona.prompt.length.toLocaleString('he')} תווים
          </span>
        </div>
        <textarea
          id="persona-prompt"
          dir="rtl"
          spellCheck={false}
          value={persona.prompt}
          onChange={(e) => update('prompt', e.target.value)}
          style={{ minHeight: 400 }}
          className={`${inputClasses} font-mono leading-relaxed`}
          placeholder="תאר את מי הפרסונה, תחומי האחריות, ה-KPI-ים, הקווים האדומים, הידע הייחודי ופערי הידע שלה…"
        />
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold">מודל ותקציב</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="מודל">
            <select
              className={inputClasses}
              value={persona.model}
              onChange={(e) => update('model', e.target.value)}
            >
              <optgroup label="Anthropic (Claude)">
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Google (Gemini)">
                {GEMINI_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="מקסימום קריאות API לפגישה" hint="תקציב קריאות מודל לפרסונה זו, לפגישה אחת (1-20)">
            <input
              type="number"
              min={1}
              max={20}
              className={inputClasses}
              value={persona.maxApiCalls}
              onChange={(e) => update('maxApiCalls', Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-3 border-t border-black/10 pt-4 dark:border-white/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">גישה לאינטרנט בזמן הפגישה</p>
              <p className="text-xs text-black/50 dark:text-white/50">
                מאפשר לפרסונה לחפש ברשת תוך כדי הדיון
              </p>
            </div>
            <Toggle
              checked={persona.webAccess}
              onChange={(v) => update('webAccess', v)}
              label="גישה לאינטרנט"
            />
          </div>
          {persona.webAccess && (
            <Field label="מקסימום חיפושים ברשת לפגישה" hint="0-10">
              <input
                type="number"
                min={0}
                max={10}
                className={`${inputClasses} max-w-40`}
                value={persona.maxWebSearches}
                onChange={(e) => update('maxWebSearches', Number(e.target.value))}
              />
            </Field>
          )}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold">קבצי רקע</h2>
        <p className="text-xs text-black/50 dark:text-white/50">
          קבצים פרטיים לפרסונה זו בלבד — הטקסט שלהם מוזרק לפרומפט שלה בכל פגישה.
        </p>
        <FileUploader files={persona.files} onUpload={handleUpload} onDelete={handleDeleteFile} />
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        title={`למחוק את "${persona.name || 'המשתתף'}"?`}
        description="הפעולה תמחק לצמיתות את המשתתף ואת כל קבצי הרקע שלו. לא ניתן לבטל פעולה זו."
        confirmLabel="מחק לצמיתות"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}

function PersonaEditorSearchParams() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  return <PersonaEditorInner id={id} />;
}

export default function PersonaEditorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-96" />
        </div>
      }
    >
      <PersonaEditorSearchParams />
    </Suspense>
  );
}
