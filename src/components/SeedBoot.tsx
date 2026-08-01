'use client';

// Virmeet — loads public/seed/ into IndexedDB once per app boot (spec §5.2).
// Renders nothing when everything is fine; shows a dismissible Hebrew banner
// only if the seed manifest couldn't be loaded at all, so a broken/missing
// manifest never silently hides itself and never crashes the app.

import { useEffect, useState } from 'react';
import { ensureSeedLoaded } from '@/lib/seed-loader';

export function SeedBoot() {
  const [warning, setWarning] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureSeedLoaded().then((result) => {
      if (!cancelled && result.status === 'error' && result.warning) {
        setWarning(result.warning);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!warning || dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <span>{warning}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
      >
        סגירה
      </button>
    </div>
  );
}
