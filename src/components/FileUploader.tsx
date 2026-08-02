'use client';

import { useRef, useState } from 'react';
import type { AttachedFile } from '@/lib/types';
import { Button, Spinner } from './ui';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} בייט`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileUploader({
  files,
  onUpload,
  onDelete,
  disabled = false,
}: {
  files: AttachedFile[];
  onUpload: (file: File) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        await onUpload(file);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'העלאת הקובץ נכשלה');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleDelete(fileId: string) {
    setDeletingId(fileId);
    setError(null);
    try {
      await onDelete(fileId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'מחיקת הקובץ נכשלה');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors
          ${dragging ? 'border-blue-500 bg-blue-500/5' : 'border-black/15 dark:border-white/15'}
          ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-black/30 dark:hover:border-white/30'}`}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-black/40 dark:text-white/40">
          <path d="M12 16V4M12 4l-4 4M12 4l4 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="text-sm font-medium">גררו קבצים לכאן או לחצו לבחירה</p>
        <p className="text-xs text-black/50 dark:text-white/50">
          txt, md, csv, json, pdf, docx, xlsx, pptx — עד 10MB לקובץ
        </p>
        {uploading && (
          <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
            <Spinner className="h-4 w-4" />
            מעלה…
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx"
          className="hidden"
          disabled={disabled}
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-sm dark:border-white/10 dark:bg-white/[0.03]"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{file.name}</span>
                <span className="flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
                  <span>{formatBytes(file.sizeBytes)}</span>
                  <span>•</span>
                  {file.extractionError ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      חילוץ טקסט נכשל: {file.extractionError}
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">טקסט חולץ בהצלחה</span>
                  )}
                </span>
              </div>
              <Button
                variant="ghost"
                className="shrink-0 !px-2 !py-1 text-red-600 dark:text-red-400"
                onClick={() => void handleDelete(file.id)}
                disabled={deletingId === file.id}
              >
                {deletingId === file.id ? <Spinner className="h-4 w-4" /> : 'מחק'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
