'use client';

import { useEffect, useState } from 'react';
import { ApiError, orgApi } from '@/lib/api-client';
import { ensureSeedLoaded } from '@/lib/seed-loader';
import type { OrgSettings } from '@/lib/types';
import { Button, Card, ErrorBanner, Field, Skeleton, inputClasses } from '@/components/ui';
import { ApiKeySettings } from '@/components/ApiKeySettings';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export default function SettingsPage() {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);

  function load() {
    setError(null);
    orgApi
      .get()
      .then(setSettings)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'טעינת ההגדרות נכשלה'));
  }

  useEffect(load, []);

  function update<K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await orgApi.update({
        organizationName: settings.organizationName,
        description: settings.description,
        constraints: settings.constraints,
      });
      setSettings(updated);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'שמירת ההגדרות נכשלה');
    } finally {
      setSaving(false);
    }
  }

  async function handleReloadFromRepo() {
    setReloading(true);
    setReloadMessage(null);
    try {
      const result = await ensureSeedLoaded({ force: true });
      if (result.status === 'error') {
        setReloadMessage(result.warning ?? 'טעינה מחדש מהריפו נכשלה.');
      } else {
        setReloadMessage(
          `הטעינה הושלמה — ${result.personaCount ?? 0} פרסונות ו-${result.meetingTypeCount ?? 0} סוגי פגישות נטענו מחדש מהריפו.`
        );
        load();
      }
    } catch (err) {
      setReloadMessage(err instanceof Error ? err.message : 'טעינה מחדש מהריפו נכשלה.');
    } finally {
      setReloading(false);
      setReloadOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">הגדרות ארגון</h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          הרקע הארגוני והאילוצים כאן מוזרקים לכל הפרסונות בכל פגישה — הם קובעים את ההקשר המשותף שלהן.
        </p>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <ApiKeySettings />

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold">פרסונות וסוגי פגישות מהריפו</h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          בכניסה ראשונה נטענות אוטומטית פרסונות וסוגי פגישות מהריפו, בלי לדרוס עריכות מקומיות.
          הכפתור הזה טוען אותן מחדש במפורש ו<strong>דורס</strong> כל עריכה מקומית שנעשתה לפרסונות
          ולסוגי הפגישות הבסיסיים (לא נוגע בפרסונות או בפגישות שיצרתם בעצמכם).
        </p>
        {reloadMessage && <p className="text-sm text-black/70 dark:text-white/70">{reloadMessage}</p>}
        <div>
          <Button variant="secondary" onClick={() => setReloadOpen(true)}>
            טען מחדש מהריפו
          </Button>
        </div>
      </Card>

      {!settings ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : (
        <Card className="flex flex-col gap-4 p-5">
          {saveError && <ErrorBanner message={saveError} />}

          <Field label="שם הארגון">
            <input
              className={inputClasses}
              value={settings.organizationName}
              onChange={(e) => update('organizationName', e.target.value)}
            />
          </Field>

          <Field label="תיאור ארגוני" hint="רקע כללי על האגף/הארגון — מבנה, מערכות, ספקים">
            <textarea
              dir="rtl"
              value={settings.description}
              onChange={(e) => update('description', e.target.value)}
              style={{ minHeight: 160 }}
              className={inputClasses}
            />
          </Field>

          <Field label="אילוצים" hint="תקציב, רגולציה, מכרזים, עומס צוותים — מה שמגביל את מרחב האפשרויות">
            <textarea
              dir="rtl"
              value={settings.constraints}
              onChange={(e) => update('constraints', e.target.value)}
              style={{ minHeight: 160 }}
              className={inputClasses}
            />
          </Field>

          <div className="flex items-center justify-end gap-3 border-t border-black/10 pt-4 dark:border-white/10">
            {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'שומר…' : 'שמור שינויים'}
            </Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={reloadOpen}
        title="לטעון מחדש מהריפו?"
        description="עריכות מקומיות לפרסונות ולסוגי הפגישות הבסיסיים (מהריפו) יאבדו ויוחלפו בגרסה
          העדכנית מהריפו. פרסונות ופגישות שיצרתם בעצמכם לא יושפעו."
        confirmLabel="טען מחדש ודרוס"
        busy={reloading}
        onConfirm={handleReloadFromRepo}
        onCancel={() => setReloadOpen(false)}
      />
    </div>
  );
}
