'use client';

import { useEffect, useState } from 'react';
import { ApiError, meetingTypesApi } from '@/lib/api-client';
import type { MeetingType } from '@/lib/types';
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Skeleton,
  inputClasses,
} from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';

const NEW_DRAFT: MeetingType = {
  id: '__new__',
  title: '',
  shortDescription: '',
  prompt: '',
  isBuiltIn: false,
  createdAt: '',
  updatedAt: '',
};

export default function MeetingTypesPage() {
  const [types, setTypes] = useState<MeetingType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MeetingType | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function load() {
    setError(null);
    meetingTypesApi
      .list()
      .then(setTypes)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'טעינת סוגי הפגישות נכשלה'));
  }

  useEffect(load, []);

  function selectType(t: MeetingType) {
    setSelectedId(t.id);
    setDraft({ ...t });
    setSaveError(null);
  }

  function startNew() {
    setSelectedId('__new__');
    setDraft({ ...NEW_DRAFT });
    setSaveError(null);
  }

  function closeEditor() {
    setSelectedId(null);
    setDraft(null);
  }

  function updateDraft<K extends keyof MeetingType>(key: K, value: MeetingType[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (selectedId === '__new__') {
        const created = await meetingTypesApi.create({
          title: draft.title,
          shortDescription: draft.shortDescription,
          prompt: draft.prompt,
        });
        setTypes((prev) => (prev ? [...prev, created] : [created]));
        selectType(created);
      } else if (draft.id) {
        const updated = await meetingTypesApi.update(draft.id, {
          title: draft.title,
          shortDescription: draft.shortDescription,
          prompt: draft.prompt,
        });
        setTypes((prev) => prev?.map((t) => (t.id === updated.id ? updated : t)) ?? prev);
        selectType(updated);
      }
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'שמירת סוג הפגישה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!draft || draft.id === '__new__') return;
    setDeleting(true);
    try {
      await meetingTypesApi.remove(draft.id);
      setTypes((prev) => prev?.filter((t) => t.id !== draft.id) ?? prev);
      closeEditor();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'מחיקת סוג הפגישה נכשלה');
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">סוגי פגישות</h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            תבניות מטרה שמכוונות את המנחה ואת המשתתפים — ניתן לערוך את המובנות, לא למחוק אותן.
          </p>
        </div>
        <Button variant="primary" onClick={startNew}>
          + סוג פגישה חדש
        </Button>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="flex flex-col gap-3">
          {types === null ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : types.length === 0 ? (
            <p className="text-sm text-black/55 dark:text-white/55">אין עדיין סוגי פגישות.</p>
          ) : (
            types.map((t) => (
              <button key={t.id} type="button" onClick={() => selectType(t)} className="text-right">
                <Card
                  className={`flex flex-col gap-1.5 p-4 transition-shadow hover:shadow-md ${
                    selectedId === t.id ? 'ring-2 ring-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold">{t.title || 'ללא כותרת'}</p>
                    {t.isBuiltIn && <Badge tone="info">מובנה</Badge>}
                  </div>
                  <p className="text-sm text-black/60 dark:text-white/60">{t.shortDescription}</p>
                </Card>
              </button>
            ))
          )}
        </div>

        <div>
          {!draft ? (
            <Card className="flex h-full items-center justify-center p-8 text-center text-sm text-black/50 dark:text-white/50">
              בחרו סוג פגישה מהרשימה כדי לערוך, או צרו סוג חדש.
            </Card>
          ) : (
            <Card className="flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  {selectedId === '__new__' ? 'סוג פגישה חדש' : 'עריכת סוג פגישה'}
                </h2>
                {draft.isBuiltIn && <Badge tone="info">מובנה — לא ניתן למחוק</Badge>}
              </div>

              {saveError && <ErrorBanner message={saveError} />}

              <Field label="כותרת">
                <input
                  className={inputClasses}
                  value={draft.title}
                  onChange={(e) => updateDraft('title', e.target.value)}
                />
              </Field>
              <Field label="הסבר קצר" hint="משפט-שניים שיוצג בכרטיס">
                <input
                  className={inputClasses}
                  value={draft.shortDescription}
                  onChange={(e) => updateDraft('shortDescription', e.target.value)}
                />
              </Field>
              <Field label="פרומפט מפורט" hint="מוזרק למנחה — מסביר מה צריך לקרות בפגישה ומה הפלט הנדרש">
                <textarea
                  dir="rtl"
                  value={draft.prompt}
                  onChange={(e) => updateDraft('prompt', e.target.value)}
                  style={{ minHeight: 220 }}
                  className={inputClasses}
                />
              </Field>

              <div className="flex items-center justify-between border-t border-black/10 pt-4 dark:border-white/10">
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={closeEditor}>
                    ביטול
                  </Button>
                  {selectedId !== '__new__' && !draft.isBuiltIn && (
                    <Button variant="danger" onClick={() => setDeleteOpen(true)}>
                      מחק
                    </Button>
                  )}
                </div>
                <Button variant="primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'שומר…' : 'שמור'}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title={`למחוק את "${draft?.title || 'סוג הפגישה'}"?`}
        description="הפעולה תמחק לצמיתות את סוג הפגישה. לא ניתן לבטל פעולה זו."
        confirmLabel="מחק לצמיתות"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
