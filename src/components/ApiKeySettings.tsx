'use client';

// Virmeet — lets a user paste a personal Anthropic and/or Gemini API key,
// stored only in this browser's localStorage. Sent directly from this
// browser to the Anthropic/Gemini API when a meeting runs (see
// lib/anthropic.ts, lib/gemini.ts) — there is no server in between.

import { useEffect, useState } from 'react';
import {
  ApiKeyProvider,
  clearStoredApiKey,
  getStoredApiKey,
  maskApiKey,
  setStoredApiKey,
} from '@/lib/api-key';
import { testApiKey, type TestApiKeyResult } from '@/lib/api-key-test';
import { Button, Card, Field, Spinner, inputClasses } from '@/components/ui';

interface ProviderConfig {
  provider: ApiKeyProvider;
  label: string;
  placeholder: string;
  keyShapeHint: string;
  looksValid: (key: string) => boolean;
}

const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic (Claude)',
    placeholder: 'sk-ant-...',
    keyShapeHint: 'מפתחות של Anthropic מתחילים ב-"sk-ant-"',
    looksValid: (key) => key.startsWith('sk-ant-'),
  },
  {
    provider: 'gemini',
    label: 'Google (Gemini)',
    placeholder: 'AIza...',
    keyShapeHint: 'מפתחות של Gemini מתחילים בדרך כלל ב-"AIza"',
    looksValid: (key) => key.startsWith('AIza'),
  },
];

function ProviderKeyField({ config }: { config: ProviderConfig }) {
  const [storedKey, setStoredKeyState] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestApiKeyResult | null>(null);

  useEffect(() => {
    setStoredKeyState(getStoredApiKey(config.provider));
  }, [config.provider]);

  const trimmedDraft = draft.trim();
  const shapeWarning = trimmedDraft.length > 0 && !config.looksValid(trimmedDraft);
  // Test whatever the user is actively looking at: the draft if they typed
  // one, otherwise the already-saved key.
  const keyToTest = trimmedDraft || storedKey || '';

  function handleSave() {
    if (!trimmedDraft) return;
    setStoredApiKey(config.provider, trimmedDraft);
    setStoredKeyState(trimmedDraft);
    setDraft('');
    setVisible(false);
    setCleared(false);
    setSaved(true);
    setTestResult(null);
  }

  function handleClear() {
    clearStoredApiKey(config.provider);
    setStoredKeyState(null);
    setSaved(false);
    setCleared(true);
    setTestResult(null);
  }

  async function handleTest() {
    if (!keyToTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testApiKey(config.provider, keyToTest);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'הבדיקה נכשלה.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-black/10 pt-4 first:border-t-0 first:pt-0 dark:border-white/10">
      <div>
        <h3 className="text-sm font-semibold">{config.label}</h3>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          {storedKey
            ? `מפתח שמור בדפדפן זה (${maskApiKey(storedKey)}). הוא ישמש למודלים של ${config.label} מהמכשיר הזה.`
            : `לא שמור מפתח בדפדפן זה. יש להזין מפתח כאן כדי להריץ פגישות עם מודלים של ${config.label}.`}
        </p>
      </div>

      <Field label="הדבקת מפתח חדש" hint={config.keyShapeHint}>
        <div className="flex gap-2">
          <input
            type={visible ? 'text' : 'password'}
            dir="ltr"
            className={`${inputClasses} text-left`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
              setCleared(false);
              setTestResult(null);
            }}
            placeholder={config.placeholder}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="button" variant="ghost" onClick={() => setVisible((v) => !v)}>
            {visible ? 'הסתר' : 'הצג'}
          </Button>
        </div>
        {shapeWarning && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            שימו לב: המפתח לא נראה כמפתח {config.label} תקין. ניתן לשמור בכל זאת.
          </p>
        )}
      </Field>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
        {cleared && <span className="text-sm text-black/50 dark:text-white/50">המפתח נמחק</span>}
        {testResult && (
          <span
            className={`text-sm ${
              testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {testResult.ok ? 'המפתח תקין ✓' : testResult.message}
          </span>
        )}
        <Button variant="secondary" onClick={handleTest} disabled={!keyToTest || testing}>
          {testing ? (
            <>
              <Spinner className="h-4 w-4" />
              בודק…
            </>
          ) : (
            'בדוק תקינות'
          )}
        </Button>
        <Button variant="danger" onClick={handleClear} disabled={!storedKey}>
          מחק מפתח
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={!trimmedDraft}>
          שמור
        </Button>
      </div>
    </div>
  );
}

export function ApiKeySettings() {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">מפתחות API אישיים</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          בחרו מודל לכל פרסונה בעמוד המשתתפים, והזינו כאן את מפתח ה-API של הספק המתאים — Anthropic
          עבור מודלי Claude, Google עבור מודלי Gemini. אין צורך להזין את שני המפתחות אם משתמשים בספק אחד בלבד.
        </p>
      </div>

      {PROVIDERS.map((config) => (
        <ProviderKeyField key={config.provider} config={config} />
      ))}

      <p className="border-t border-black/10 pt-4 text-xs text-black/50 dark:border-white/10 dark:text-white/50">
        Virmeet הוא אתר סטטי ללא שרת משלו — המפתחות נשמרים רק ב-localStorage של הדפדפן, על המכשיר הזה
        בלבד, ונשלחים ישירות מהדפדפן אל ה-API של הספק המתאים (Anthropic / Google) כדי להריץ פגישה, בלי
        לעבור דרך שום שרת של Virmeet. כל סקריפט שרץ בדף יכול לקרוא אותם, ולכן זה מתאים לשימוש אישי
        במכשיר שלכם ולא למחשב משותף.
      </p>
    </Card>
  );
}
