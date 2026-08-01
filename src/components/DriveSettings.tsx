'use client';

// Virmeet — connects a Google Drive folder tree (VIRMEET/<persona name>/) as
// per-persona knowledge storage. Browser-only OAuth via Google Identity
// Services (drive-auth.ts); the access token lives only in memory for this
// tab (drive-session.ts) — never localStorage, unlike the Gemini key, since
// it's short-lived and re-consenting is quick.

import { useEffect, useState } from 'react';
import { ApiError, driveApi, personasApi } from '@/lib/api-client';
import { clearStoredDriveClientId, getStoredDriveClientId, setStoredDriveClientId } from '@/lib/drive-key';
import { requestDriveAccessToken, revokeDriveAccess } from '@/lib/drive-auth';
import { getDriveAccessToken, isDriveConnected } from '@/lib/drive-session';
import { ensurePersonaFolder, ensureVirmeetRootFolder, VIRMEET_ROOT_FOLDER_NAME } from '@/lib/drive';
import type { Persona } from '@/lib/types';
import { Button, Card, ErrorBanner, Field, Spinner, inputClasses } from '@/components/ui';

type ProvisionResult = {
  personaId: string;
  name: string;
  status: 'created' | 'existing' | 'error';
  message?: string;
};

export function DriveSettings() {
  const [storedClientId, setStoredClientIdState] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [rootFolderId, setRootFolderId] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResults, setProvisionResults] = useState<ProvisionResult[] | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  useEffect(() => {
    setStoredClientIdState(getStoredDriveClientId());
    setConnected(isDriveConnected());
    driveApi
      .getRootFolderId()
      .then((id) => setRootFolderId(id ?? null))
      .catch(() => {});
  }, []);

  const trimmedDraft = draft.trim();
  const clientIdToUse = trimmedDraft || storedClientId || '';

  function handleSaveClientId() {
    if (!trimmedDraft) return;
    setStoredDriveClientId(trimmedDraft);
    setStoredClientIdState(trimmedDraft);
    setDraft('');
    setSaved(true);
    setCleared(false);
  }

  function handleClearClientId() {
    clearStoredDriveClientId();
    setStoredClientIdState(null);
    setSaved(false);
    setCleared(true);
  }

  async function handleConnect() {
    if (!clientIdToUse) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await requestDriveAccessToken(clientIdToUse);
      setConnected(true);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'ההתחברות ל-Drive נכשלה.');
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await revokeDriveAccess();
    setConnected(false);
    setProvisionResults(null);
  }

  async function handleProvision() {
    const token = getDriveAccessToken();
    if (!token) {
      setConnectError('החיבור פג — יש להתחבר מחדש לפני יצירת מבנה התיקיות.');
      setConnected(false);
      return;
    }
    setProvisioning(true);
    setProvisionError(null);
    setProvisionResults(null);
    try {
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
    } catch (err) {
      setProvisionError(
        err instanceof ApiError || err instanceof Error ? err.message : 'יצירת מבנה התיקיות ב-Drive נכשלה.'
      );
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">חיבור ל-Google Drive (ידע לפרסונות)</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          מחבר תיקיית Drive שבה כל פרסונה מקבלת תיקיית ידע פרטית משלה
          (<code dir="ltr">{VIRMEET_ROOT_FOLDER_NAME}/&lt;שם הפרסונה&gt;/</code>). קבצים שתגררו לשם ידנית דרך
          Drive ישמשו כרקע לפרסונה המתאימה (בשלבים הבאים).
        </p>
      </div>

      <Field label="Drive OAuth Client ID" hint="נוצר ב-Google Cloud Console (Web application). לא סוד — מזהה ציבורי.">
        <div className="flex gap-2">
          <input
            dir="ltr"
            className={`${inputClasses} text-left`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
              setCleared(false);
            }}
            placeholder="xxxxxxxxxx.apps.googleusercontent.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </Field>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-black/10 pt-4 dark:border-white/10">
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
        {cleared && <span className="text-sm text-black/50 dark:text-white/50">ה-Client ID נמחק</span>}
        <Button variant="danger" onClick={handleClearClientId} disabled={!storedClientId}>
          מחק Client ID
        </Button>
        <Button variant="primary" onClick={handleSaveClientId} disabled={!trimmedDraft}>
          שמור
        </Button>
      </div>

      <div className="flex flex-col gap-3 border-t border-black/10 pt-4 dark:border-white/10">
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
              <Button variant="secondary" onClick={handleDisconnect}>
                התנתק
              </Button>
            )}
            <Button variant="secondary" onClick={handleConnect} disabled={!clientIdToUse || connecting}>
              {connecting ? (
                <>
                  <Spinner className="h-4 w-4" />
                  מתחבר…
                </>
              ) : connected ? (
                'התחבר מחדש'
              ) : (
                'התחבר ל-Drive'
              )}
            </Button>
          </div>
        </div>
        {connectError && <ErrorBanner message={connectError} />}
      </div>

      {connected && (
        <div className="flex flex-col gap-3 border-t border-black/10 pt-4 dark:border-white/10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">מבנה תיקיות</p>
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
            </div>
            <Button variant="secondary" onClick={handleProvision} disabled={provisioning}>
              {provisioning ? (
                <>
                  <Spinner className="h-4 w-4" />
                  יוצר…
                </>
              ) : (
                'צור/רענן מבנה תיקיות ב-Drive'
              )}
            </Button>
          </div>
          {provisionError && <ErrorBanner message={provisionError} />}
          {provisionResults && provisionResults.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {provisionResults.map((r) => (
                <li key={r.personaId} className="flex items-center gap-2">
                  {r.status === 'error' ? (
                    <span className="text-red-600 dark:text-red-400">✗ {r.name}: {r.message}</span>
                  ) : (
                    <span className="text-black/70 dark:text-white/70">
                      ✓ {r.name} — {r.status === 'created' ? 'נוצרה תיקייה חדשה' : 'תיקייה כבר קיימת'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="border-t border-black/10 pt-4 text-xs text-black/50 dark:border-white/10 dark:text-white/50">
        החיבור מבקש הרשאת גישה מלאה ל-Drive שלכם (קריאה וכתיבה), כי המנגנון צריך לראות קבצים שתגררו
        ידנית לתוך תיקיות הפרסונות — לא רק קבצים שהוא עצמו יצר. אסימון הגישה נשמר בזיכרון הדפדפן בלבד
        (לא ב-localStorage) ונעלם בסגירת/רענון הלשונית; ה-Client ID עצמו אינו סוד ונשמר מקומית כדי לא
        להזין אותו בכל פעם.
      </p>
    </Card>
  );
}
