'use client';

// Virmeet — lets a user paste a personal Gemini API key, stored only in this
// browser's localStorage. Sent directly from this browser to the Gemini API
// when a meeting runs (see lib/gemini.ts) — there is no server in between.

import { useEffect, useState } from 'react';
import { clearStoredApiKey, getStoredApiKey, maskApiKey, setStoredApiKey } from '@/lib/api-key';
import { testApiKey, type TestApiKeyResult } from '@/lib/api-key-test';
import { Button, Card, Field, Spinner, inputClasses } from '@/components/ui';

export function ApiKeySettings() {
  const [storedKey, setStoredKeyState] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestApiKeyResult | null>(null);

  useEffect(() => {
    setStoredKeyState(getStoredApiKey());
  }, []);

  const trimmedDraft = draft.trim();
  const shapeWarning = trimmedDraft.length > 0 && !trimmedDraft.startsWith('AIza');
  // Test whatever the user is actively looking at: the draft if they typed
  // one, otherwise the already-saved key.
  const keyToTest = trimmedDraft || storedKey || '';

  function handleSave() {
    if (!trimmedDraft) return;
    setStoredApiKey(trimmedDraft);
    setStoredKeyState(trimmedDraft);
    setDraft('');
    setVisible(false);
    setCleared(false);
    setSaved(true);
    setTestResult(null);
  }

  function handleClear() {
    clearStoredApiKey();
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
      const result = await testApiKey(keyToTest);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'הבדיקה נכשלה.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">מפתח API אישי של Gemini</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          {storedKey
            ? `מפתח שמור בדפדפן זה (${maskApiKey(storedKey)}). הוא ישמש להרצת פגישות מהמכשיר הזה.`
            : 'לא שמור מפתח בדפדפן זה. יש להזין מפתח כאן כדי להריץ פגישות.'}
        </p>
      </div>

      <Field label="הדבקת מפתח חדש" hint='מפתחות של Gemini מתחילים בדרך כלל ב-"AIza"'>
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
            placeholder="AIza..."
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="button" variant="ghost" onClick={() => setVisible((v) => !v)}>
            {visible ? 'הסתר' : 'הצג'}
          </Button>
        </div>
        {shapeWarning && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            שימו לב: המפתח לא נראה כמפתח Gemini תקין. ניתן לשמור בכל זאת.
          </p>
        )}
      </Field>

      <div className="flex items-center justify-end gap-3 border-t border-black/10 pt-4 dark:border-white/10">
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

      <p className="border-t border-black/10 pt-4 text-xs text-black/50 dark:border-white/10 dark:text-white/50">
        Virmeet הוא אתר סטטי ללא שרת משלו — המפתח נשמר רק ב-localStorage של הדפדפן, על המכשיר הזה בלבד,
        ונשלח ישירות מהדפדפן אל ה-API של Gemini כדי להריץ פגישה, בלי לעבור דרך שום שרת של Virmeet. כל
        סקריפט שרץ בדף יכול לקרוא אותו, ולכן זה מתאים לשימוש אישי במכשיר שלכם ולא למחשב משותף.
      </p>
    </Card>
  );
}
