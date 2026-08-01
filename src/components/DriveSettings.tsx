'use client';

// Virmeet — connects a Google Drive folder tree (VIRMEET/<persona name>/) as
// per-persona knowledge storage. Browser-only OAuth via Google Identity
// Services (drive-auth.ts); the access token lives only in memory for this
// tab (drive-session.ts) — never localStorage, unlike the Gemini key, since
// it's short-lived and re-consenting is quick.
//
// One button, not two: unlike the Gemini key, the OAuth Client ID isn't a
// per-user secret — it identifies the app itself, baked in at build time
// (DRIVE_CLIENT_ID, from NEXT_PUBLIC_DRIVE_CLIENT_ID — see .env.local and
// deploy-pages.yml). So there's nothing for a visitor to paste: clicking
// "התחבר ל-Drive" runs the OAuth popup *and* provisions the folder
// structure in one go.

import { useEffect, useState } from 'react';
import { ApiError, driveApi, personasApi } from '@/lib/api-client';
import { DRIVE_CLIENT_ID, requestDriveAccessToken, revokeDriveAccess } from '@/lib/drive-auth';
import { getDriveAccessToken, isDriveConnected } from '@/lib/drive-session';
import { ensurePersonaFolder, ensureVirmeetRootFolder, VIRMEET_ROOT_FOLDER_NAME } from '@/lib/drive';
import type { Persona } from '@/lib/types';
import { Button, Card, ErrorBanner, Spinner } from '@/components/ui';

type ProvisionResult = {
  personaId: string;
  name: string;
  status: 'created' | 'existing' | 'error';
  message?: string;
};

export function DriveSettings() {
  const [connected, setConnected] = useState(false);
  const [working, setWorking] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [rootFolderId, setRootFolderId] = useState<string | null>(null);
  const [provisionResults, setProvisionResults] = useState<ProvisionResult[] | null>(null);

  useEffect(() => {
    setConnected(isDriveConnected());
    driveApi
      .getRootFolderId()
      .then((id) => setRootFolderId(id ?? null))
      .catch(() => {});
  }, []);

  async function provisionFolders(token: string) {
    const root = await ensureVirmeetRootFolder(token);
    setRootFolderId(root.id);
    await driveApi.setRootFolderId(root.id);

    const personas: Persona[] = await personasApi.list();
    const activePersonas = personas.filter((p) => p.isActive);

    const results: ProvisionResult[] = [];
    for (const persona of activePersonas) {
      try {
        const folder = await ensurePersonaFolder(token, root.id, persona.name);
        await personasApi.setDriveFolderId(persona.id, folder.id);
        results.push({
          personaId: persona.id,
          name: persona.name,
          status: folder.created ? 'created' : 'existing',
        });
      } catch (err) {
        results.push({
          personaId: persona.id,
          name: persona.name,
          status: 'error',
          message: err instanceof Error ? err.message : 'שגיאה לא צפויה',
        });
      }
      setProvisionResults([...results]);
    }
  }

  async function handleConnect() {
    setWorking(true);
    setConnectError(null);
    setProvisionResults(null);
    try {
      await requestDriveAccessToken(DRIVE_CLIENT_ID);
      setConnected(true);
      const token = getDriveAccessToken();
      if (token) await provisionFolders(token);
    } catch (err) {
      setConnectError(
        err instanceof ApiError || err instanceof Error ? err.message : 'ההתחברות ל-Drive נכשלה.'
      );
    } finally {
      setWorking(false);
    }
  }

  async function handleDisconnect() {
    await revokeDriveAccess();
    setConnected(false);
    setProvisionResults(null);
  }

  if (!DRIVE_CLIENT_ID) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        <h2 className="text-sm font-semibold">חיבור ל-Google Drive (ידע לפרסונות)</h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          התכונה הזו לא הוגדרה עדיין באתר הזה — חסר <code dir="ltr">NEXT_PUBLIC_DRIVE_CLIENT_ID</code>.
          זו הגדרה של מריץ האתר (לא של המשתמש): ראו את הסבר ההגדרה ב-README, תחת &quot;חיבור ל-Google
          Drive&quot;.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">חיבור ל-Google Drive (ידע לפרסונות)</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          מחבר תיקיית Drive שבה כל פרסונה מקבלת תיקיית ידע פרטית משלה
          (<code dir="ltr">{VIRMEET_ROOT_FOLDER_NAME}/&lt;שם הפרסונה&gt;/</code>). קבצים שתגררו לשם
          ידנית דרך Drive ישמשו כרקע לפרסונה המתאימה. לחיצה אחת מתחברת עם חשבון ה-Google שלכם ומקימה
          את מבנה התיקיות — אין צורך בשום הגדרה נוספת.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {connected ? (
            <span className="text-emerald-600 dark:text-emerald-400">מחובר ל-Drive ✓</span>
          ) : (
            <span className="text-black/55 dark:text-white/55">לא מחובר</span>
          )}
        </p>
        <div className="flex gap-2">
          {connected && (
            <Button variant="secondary" onClick={handleDisconnect} disabled={working}>
              התנתק
            </Button>
          )}
          <Button variant="primary" onClick={handleConnect} disabled={working}>
            {working ? (
              <>
                <Spinner className="h-4 w-4" />
                מתחבר ומקים תיקיות…
              </>
            ) : connected ? (
              'התחבר מחדש ורענן תיקיות'
            ) : (
              'התחבר ל-Drive'
            )}
          </Button>
        </div>
      </div>

      {connectError && <ErrorBanner message={connectError} />}

      {rootFolderId && (
        <a
          href={`https://drive.google.com/drive/folders/${rootFolderId}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          פתיחת תיקיית {VIRMEET_ROOT_FOLDER_NAME} ב-Drive
        </a>
      )}

      {provisionResults && provisionResults.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {provisionResults.map((r) => (
            <li key={r.personaId} className="flex items-center gap-2">
              {r.status === 'error' ? (
                <span className="text-red-600 dark:text-red-400">
                  ✗ {r.name}: {r.message}
                </span>
              ) : (
                <span className="text-black/70 dark:text-white/70">
                  ✓ {r.name} — {r.status === 'created' ? 'נוצרה תיקייה חדשה' : 'תיקייה כבר קיימת'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-black/10 pt-4 text-xs text-black/50 dark:border-white/10 dark:text-white/50">
        החיבור מבקש הרשאת גישה מלאה ל-Drive שלכם (קריאה וכתיבה), כי המנגנון צריך לראות קבצים שתגררו
        ידנית לתוך תיקיות הפרסונות — לא רק קבצים שהוא עצמו יצר. אסימון הגישה נשמר בזיכרון הדפדפן בלבד
        (לא ב-localStorage) ונעלם בסגירת/רענון הלשונית, ודורש התחברות מחדש בכל פעם.
      </p>
    </Card>
  );
}
