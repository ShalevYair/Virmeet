'use client';

// Virmeet — lets a user paste a personal Gemini API key, stored only in
// this browser's localStorage. Never sent anywhere except as the
// x-gemini-api-key header on POST /api/meetings/[id]/run (see api-client.ts).

import { useEffect, useState } from 'react';
import { clearStoredApiKey, getStoredApiKey, maskApiKey, setStoredApiKey } from '@/lib/api-key';
import { Button, Card, Field, inputClasses } from '@/components/ui';

export function ApiKeySettings() {
  const [storedKey, setStoredKeyState] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    setStoredKeyState(getStoredApiKey());
  }, []);

  const trimmedDraft = draft.trim();
  const shapeWarning = trimmedDraft.length > 0 && !trimmedDraft.startsWith('AIza');

  function handleSave() {
    if (!trimmedDraft) return;
    setStoredApiKey(trimmedDraft);
    setStoredKeyState(trimmedDraft);
    setDraft('');
    setVisible(false);
    setCleared(false);
    setSaved(true);
  }

  function handleClear() {
    clearStoredApiKey();
    setStoredKeyState(null);
    setSaved(false);
    setCleared(true);
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">מפתח API אישי של Gemini</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          {storedKey
            ? `מפתח שמור בדפדפן זה (${maskApiKey(storedKey)}). הוא ישמש להרצת פגישות מהמכשיר הזה.`
            : 'לא שמור מפתח בדפדפן זה. אם לשרת אין מפתח משלו, יש להזין מפתח כאן כדי להריץ פגישות.'}
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
            שימו לב: המפתח לא נראה כמפתח Gemini תקין (אמור להתחיל ב-&quot;AIza&quot;). ניתן לשמור בכל זאת.
          </p>
        )}
      </Field>

      <p className="text-xs text-black/50 dark:text-white/50">
        המפתח נשמר רק ב-localStorage של הדפדפן, על המכשיר הזה בלבד — הוא לא נשלח לשום מקום מלבד לשרת של
        Virmeet, ורק כדי להריץ פגישה בפועל מול ה-API של Gemini. כל סקריפט שרץ בדף יכול לקרוא אותו, ולכן
        זה מתאים לשימוש אישי במכשיר שלכם ולא למחשב משותף.
      </p>

      <div className="flex items-center justify-end gap-3 border-t border-black/10 pt-4 dark:border-white/10">
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
        {cleared && <span className="text-sm text-black/50 dark:text-white/50">המפתח נמחק</span>}
        <Button variant="danger" onClick={handleClear} disabled={!storedKey}>
          מחק מפתח
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={!trimmedDraft}>
          שמור
        </Button>
      </div>
    </Card>
  );
}
