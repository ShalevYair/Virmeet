'use client';

import { useEffect, useState } from 'react';
import { ApiError, orgApi } from '@/lib/api-client';
import type { OrgSettings } from '@/lib/types';
import { Button, Card, ErrorBanner, Field, Skeleton, inputClasses } from '@/components/ui';
import { ApiKeySettings } from '@/components/ApiKeySettings';

export default function SettingsPage() {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
        maxMeetingApiCalls: settings.maxMeetingApiCalls,
        maxMeetingTokens: settings.maxMeetingTokens,
      });
      setSettings(updated);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'שמירת ההגדרות נכשלה');
    } finally {
      setSaving(false);
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="תקרת קריאות מודל לפגישה" hint="מספר קריאות המודל המרבי המותר בפגישה אחת, בכל הפרסונות והמנחה יחד">
              <input
                type="number"
                min={1}
                max={500}
                className={inputClasses}
                value={settings.maxMeetingApiCalls}
                onChange={(e) => update('maxMeetingApiCalls', Number(e.target.value))}
              />
            </Field>

            <Field label="תקרת טוקנים לפגישה" hint="סך טוקני קלט, פלט ו-cache מותרים בפגישה אחת">
              <input
                type="number"
                min={1000}
                max={20_000_000}
                step={1000}
                className={inputClasses}
                value={settings.maxMeetingTokens}
                onChange={(e) => update('maxMeetingTokens', Number(e.target.value))}
              />
            </Field>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-black/10 pt-4 dark:border-white/10">
            {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'שומר…' : 'שמור שינויים'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
