'use client';

// Virmeet — small shared UI atoms. Tailwind only, no external component libs.

import { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-white/5 ${className}`}
    >
      {children}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-600/50 focus-visible:outline-blue-600',
  secondary:
    'bg-black/5 text-current hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 disabled:opacity-50',
  danger:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50 focus-visible:outline-red-600',
  ghost: 'bg-transparent hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50',
};

/**
 * The visual classes a <Button> renders with — exported so a non-<button>
 * element (e.g. a download `<a>`, which must never be nested inside a real
 * `<button>`; spec P5.2) can look identical without an invalid DOM nesting.
 */
export function buttonClasses(variant: ButtonVariant = 'secondary', className = ''): string {
  return `inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium
    transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
    disabled:cursor-not-allowed ${variantClasses[variant]} ${className}`;
}

export function Button({
  children,
  variant = 'secondary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button className={buttonClasses(variant, className)} {...rest}>
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-black/5 text-current dark:bg-white/10',
    success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    danger: 'bg-red-500/15 text-red-700 dark:text-red-400',
    info: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-black/10 dark:bg-white/10 ${className}`}
      aria-hidden
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-black/15 p-12 text-center dark:border-white/15">
      {icon && <div className="text-black/30 dark:text-white/30">{icon}</div>}
      <p className="text-base font-medium">{title}</p>
      {description && (
        <p className="max-w-md text-sm text-black/60 dark:text-white/60">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400"
    >
      <div className="flex items-center gap-2">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="13" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{message}</span>
      </div>
      {onRetry && (
        <Button variant="ghost" className="shrink-0 !px-2 !py-1 text-red-700 dark:text-red-400" onClick={onRetry}>
          נסה שוב
        </Button>
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-black/50 dark:text-white/50">{hint}</p>}
    </div>
  );
}

export const inputClasses =
  'w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none ' +
  'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/15 dark:bg-black/20 ' +
  'placeholder:text-black/35 dark:placeholder:text-white/35';

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-1 transition-colors ${
        checked ? 'bg-blue-600' : 'bg-black/20 dark:bg-white/20'
      }`}
    >
      {label && <span className="sr-only">{label}</span>}
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? '-translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
