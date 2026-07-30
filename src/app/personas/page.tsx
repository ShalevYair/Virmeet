'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiError, personasApi } from '@/lib/api-client';
import { exportPersonaToFile, importPersonaFile, resolveImportConflicts } from '@/lib/persona-io';
import type { PersonaSeed } from '@/lib/seed-schemas';
import { MODELS, type Persona } from '@/lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Skeleton } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PersonaAvatar } from '@/components/PersonaAvatar';

const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f'];

function randomColor(existingCount: number): string {
  return PALETTE[existingCount % PALETTE.length];
}

export default function PersonasPage() {
  const router = useRouter();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<PersonaSeed[] | null>(null);
  const [resolvingConflicts, setResolvingConflicts] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    setError(null);
    personasApi
      .list()
      .then(setPersonas)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'טעינת המשתתפים נכשלה'));
  }

  useEffect(load, []);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const persona = await personasApi.create({
        name: 'משתתף חדש',
        role: '',
        organization: '',
        color: randomColor(personas?.length ?? 0),
        prompt: '',
        model: MODELS.persona,
        webAccess: false,
        maxApiCalls: 8,
        maxWebSearches: 3,
        isActive: true,
      });
      router.push(`/personas/edit/?id=${persona.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'יצירת משתתף חדש נכשלה');
      setCreating(false);
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    setError(null);
    try {
      const text = await file.text();
      const result = await importPersonaFile(text);
      if (result.conflicts.length > 0) {
        setPendingConflicts(result.conflicts);
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ייבוא הפרסונה נכשל');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleResolveConflicts(resolution: 'overwrite' | 'copy') {
    if (!pendingConflicts) return;
    setResolvingConflicts(true);
    try {
      await resolveImportConflicts(pendingConflicts, resolution);
      setPendingConflicts(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ייבוא הפרסונה נכשל');
    } finally {
      setResolvingConflicts(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">משתתפים</h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            הפרסונות שישתתפו בסימולציות הפגישה — לכל אחת פרומפט, מודל ותקציב משלה.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
          />
          <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            {importing ? 'מייבא…' : 'ייבוא JSON'}
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={creating}>
            {creating ? 'יוצר…' : '+ הוסף משתתף'}
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {personas === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : personas.length === 0 ? (
        <EmptyState
          title="עדיין אין משתתפים"
          description="הוסיפו את המשתתף הראשון כדי להתחיל לבנות פגישות סימולציה."
          action={
            <Button variant="primary" onClick={handleCreate} disabled={creating}>
              + הוסף משתתף
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {personas.map((p) => (
            <Link key={p.id} href={`/personas/edit/?id=${p.id}`}>
              <Card className="flex h-full flex-col gap-3 p-4 transition-shadow hover:shadow-md">
                <div className="flex items-center gap-3">
                  <PersonaAvatar name={p.name} color={p.color} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{p.name || 'ללא שם'}</p>
                    <p className="truncate text-xs text-black/55 dark:text-white/55">{p.role || '—'}</p>
                  </div>
                  <Button
                    variant="ghost"
                    className="shrink-0 !px-2 !py-1 text-xs"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      exportPersonaToFile(p);
                    }}
                  >
                    ייצוא
                  </Button>
                </div>
                <p className="line-clamp-2 text-xs text-black/55 dark:text-white/55">
                  {p.organization || 'ללא ארגון'}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                  {!p.isActive && <Badge tone="neutral">לא פעיל</Badge>}
                  {p.webAccess && <Badge tone="info">גישה לאינטרנט</Badge>}
                  <Badge tone="neutral">{p.model}</Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingConflicts !== null}
        title="נמצאו פרסונות עם מזהה קיים"
        description={
          <>
            {pendingConflicts?.length === 1
              ? `הפרסונה "${pendingConflicts[0].name}" כבר קיימת.`
              : `${pendingConflicts?.length ?? 0} מהפרסונות בקובץ כבר קיימות.`}{' '}
            אפשר לדרוס את הגרסה הקיימת, או לייבא כעותק חדש עם מזהה משלו.
          </>
        }
        confirmLabel="דרוס קיימות"
        cancelLabel="ייבוא כעותק"
        danger
        busy={resolvingConflicts}
        onConfirm={() => handleResolveConflicts('overwrite')}
        onCancel={() => handleResolveConflicts('copy')}
      />
    </div>
  );
}
