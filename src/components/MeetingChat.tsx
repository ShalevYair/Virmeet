'use client';

// Virmeet — post-meeting chat: once a meeting has completed, lets the user
// ask a general question, ask one specific participant directly, or open an
// additional discussion round that gets appended to the meeting's own
// transcript. Shown on the same meetings/view page whether the meeting just
// finished running in this tab or is being reopened later (see
// src/app/meetings/view/page.tsx) — there is no separate "past meeting"
// route.

import { FormEvent, useState } from 'react';
import { chatApi } from '@/lib/api-client';
import type { ChatMessage, ChatMode, Persona, TranscriptEntry } from '@/lib/types';
import { Button, Card, ErrorBanner, Spinner, inputClasses } from '@/components/ui';
import { PersonaAvatar } from '@/components/PersonaAvatar';

type ComposerMode = ChatMode | 'round';

const MODE_LABELS: Record<ComposerMode, string> = {
  general: 'שאלה כללית',
  persona: 'שיחה עם משתתף',
  round: 'סבב דיון נוסף',
};

const MODE_PLACEHOLDERS: Record<ComposerMode, string> = {
  general: 'שאלה כללית על הפגישה, לא מנקודת המבט של משתתף מסוים…',
  persona: 'מה תרצה/י לשאול את המשתתף שנבחר?',
  round: 'על מה יעסוק סבב הדיון הנוסף? (יתווסף לתמליל הפגישה למעלה)',
};

const FACILITATOR_COLOR = '#334155';

function ChatBubble({ message, personaById }: { message: ChatMessage; personaById: Map<string, Persona> }) {
  const persona = message.personaId ? personaById.get(message.personaId) : undefined;
  const answererName = message.mode === 'persona' ? (persona?.name ?? 'משתתף') : 'מנחה';
  const color = message.mode === 'persona' ? (persona?.color ?? '#64748b') : FACILITATOR_COLOR;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-blue-600 px-3 py-2 text-sm text-white">
          {message.question}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <PersonaAvatar name={answererName} color={color} size={28} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-black/55 dark:text-white/55">{answererName}</div>
          <div className="mt-0.5 whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-black/10 bg-black/[0.02] p-3 text-sm leading-relaxed dark:border-white/10 dark:bg-white/[0.04]">
            {message.refused ? 'לא התקבלה תשובה — הבקשה סורבה על ידי המודל.' : message.answer}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MeetingChat({
  meetingId,
  participants,
  initialChat,
  onRoundEntry,
  onRoundComplete,
}: {
  meetingId: string;
  /** The meeting's own participants — a question in 'persona' mode can only be directed at one of them. */
  participants: Persona[];
  initialChat: ChatMessage[];
  /** Streamed once per participant as an additional discussion round runs, so the transcript card above can update live, same as during the original run. */
  onRoundEntry?: (entry: TranscriptEntry) => void;
  /** Called once an additional discussion round finishes, so the caller can refresh usage/discussionRounds from storage. */
  onRoundComplete?: () => void;
}) {
  const [mode, setMode] = useState<ComposerMode>('general');
  const [personaId, setPersonaId] = useState(participants[0]?.id ?? '');
  const [draft, setDraft] = useState('');
  const [chat, setChat] = useState<ChatMessage[]>(initialChat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roundNotice, setRoundNotice] = useState<string | null>(null);

  const personaById = new Map(participants.map((p) => [p.id, p]));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;

    setBusy(true);
    setError(null);
    setRoundNotice(null);
    try {
      if (mode === 'general') {
        const message = await chatApi.askGeneral(meetingId, question);
        setChat((prev) => [...prev, message]);
      } else if (mode === 'persona') {
        if (!personaId) {
          setError('יש לבחור משתתף לפני שליחת השאלה.');
          return;
        }
        const message = await chatApi.askPersona(meetingId, personaId, question);
        setChat((prev) => [...prev, message]);
      } else {
        await chatApi.runAdditionalRound(meetingId, question, { onEntry: onRoundEntry });
        onRoundComplete?.();
        setRoundNotice('סבב הדיון הנוסף נוסף לתמליל הפגישה למעלה.');
      }
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'הפעולה נכשלה.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">צ&apos;אט אחרי הפגישה</h2>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          אפשר לשאול שאלה כללית על הפגישה, לפנות ישירות למשתתף מסוים, או לפתוח סבב דיון נוסף שמתווסף
          לתמליל הפגישה עצמה.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-black/10 pb-3 dark:border-white/10">
        {(Object.keys(MODE_LABELS) as ComposerMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === m
                ? 'bg-blue-600 text-white'
                : 'text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10'
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {chat.length > 0 && (
        <div className="flex flex-col gap-4">
          {chat.map((m) => (
            <ChatBubble key={m.id} message={m} personaById={personaById} />
          ))}
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {roundNotice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{roundNotice}</p>}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === 'persona' && (
          <select
            dir="rtl"
            className={inputClasses}
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
          >
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.role})
              </option>
            ))}
          </select>
        )}
        <textarea
          dir="rtl"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ minHeight: 80 }}
          className={inputClasses}
          placeholder={MODE_PLACEHOLDERS[mode]}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
            {busy ? (
              <>
                <Spinner className="h-4 w-4" />
                {mode === 'round' ? 'מריץ סבב דיון…' : 'שולח…'}
              </>
            ) : mode === 'round' ? (
              'התחל סבב דיון נוסף'
            ) : (
              'שלח'
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}
