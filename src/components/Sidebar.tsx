'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';

const NAV_ITEMS: { href: string; label: string; icon: ReactNode; match: (p: string) => boolean }[] = [
  {
    href: '/',
    label: 'לוח מחוונים',
    match: (p) => p === '/',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="5" rx="1.5" />
        <rect x="13" y="10" width="8" height="11" rx="1.5" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" />
      </svg>
    ),
  },
  {
    href: '/meetings',
    label: 'פגישות',
    match: (p) => p.startsWith('/meetings'),
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 3v3M16 3v3M4 9h16" strokeLinecap="round" />
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 13h3M8 17h6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/personas',
    label: 'משתתפים',
    match: (p) => p.startsWith('/personas'),
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 20c.7-3.4 3-5.4 5.5-5.4s4.8 2 5.5 5.4" strokeLinecap="round" />
        <circle cx="17" cy="8.5" r="2.4" />
        <path d="M15.2 14.9c2.1.3 3.7 2.1 4.3 5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/meeting-types',
    label: 'סוגי פגישות',
    match: (p) => p.startsWith('/meeting-types'),
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 19.5V6a2 2 0 012-2h9l5 5v10.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19.5z" />
        <path d="M14 4v4a1 1 0 001 1h4" />
        <path d="M8 13h8M8 16.5h5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/settings',
    label: 'הגדרות',
    match: (p) => p.startsWith('/settings'),
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 13a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V19a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.03-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.56-1.03H4a2 2 0 110-4h.09a1.7 1.7 0 001.56-1.03 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H10a1.7 1.7 0 001.03-1.56V4a2 2 0 114 0v.09a1.7 1.7 0 001.03 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V10a1.7 1.7 0 001.56 1.03H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1.03z"
        />
      </svg>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname() || '/';

  return (
    <nav
      dir="rtl"
      aria-label="ניווט ראשי"
      className="fixed inset-y-0 right-0 z-40 flex w-56 flex-col gap-1 overflow-y-auto border-e border-black/10 bg-white/90 px-3 py-5 backdrop-blur-sm dark:border-white/10 dark:bg-[#141417]/90"
    >
      <Link href="/" className="mb-4 flex items-center gap-2 px-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white">
          V
        </span>
        <span className="text-base font-semibold">Virmeet</span>
      </Link>

      {NAV_ITEMS.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              active
                ? 'bg-blue-600/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
                : 'text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10'
            }`}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}

      <div className="mt-auto px-2 text-xs text-black/40 dark:text-white/40">
        סימולציית פגישה רב-משתתפים
      </div>
    </nav>
  );
}
