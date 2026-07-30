// Virmeet — Markdown export renderer + browser download helper (spec §6).
// The disclaimer banner below must be reproduced verbatim, byte-for-byte, as
// the opening lines of every Markdown export. Moved from the old
// src/app/api/meetings/[id]/export/render.ts as-is; only the download
// mechanism (Blob + object URL, since there's no server route to stream
// from) is new.

import { Meeting, MeetingTask, Persona, TranscriptEntry } from './types';

export const DISCLAIMER_HE =
  'הפלט הזה הוא הכנה לפגישה, לא תחליף לה. הדעות כאן נוצרו על ידי מודל שפה ואינן מייצגות את עמדתם של אנשים אמיתיים.';

const PHASE_LABELS_HE: Record<TranscriptEntry['phase'], string> = {
  prep: 'הכנה',
  opening: 'פתיחה',
  discussion: 'דיון',
  convergence: 'התכנסות',
  extraction: 'חילוץ משימות',
};

const STATUS_LABELS_HE: Record<Meeting['status'], string> = {
  draft: 'טיוטה',
  running: 'רצה כעת',
  completed: 'הושלמה',
  failed: 'נכשלה',
  cancelled: 'בוטלה',
};

const PRIORITY_LABELS_HE: Record<MeetingTask['priority'], string> = {
  high: 'גבוהה',
  medium: 'בינונית',
  low: 'נמוכה',
};

function renderTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return '(אין תמליל)';
  return transcript
    .map((e) => {
      const roundPart = e.round != null ? `, סבב ${e.round}` : '';
      const searches =
        e.webSearches && e.webSearches.length > 0
          ? `\n\n_חיפושי רשת: ${e.webSearches.map((s) => s.query).join('; ')}_`
          : '';
      return `**[${PHASE_LABELS_HE[e.phase]}${roundPart}] ${e.speakerName}:**\n${e.text}${searches}`;
    })
    .join('\n\n---\n\n');
}

function renderTasksByOwner(tasks: MeetingTask[]): string {
  if (tasks.length === 0) return '(אין משימות)';
  const grouped = new Map<string, MeetingTask[]>();
  for (const task of tasks) {
    const key = task.ownerName || 'לא שויך';
    grouped.set(key, [...(grouped.get(key) ?? []), task]);
  }
  const sections: string[] = [];
  for (const [owner, ownerTasks] of grouped) {
    const items = ownerTasks
      .map(
        (t) =>
          `- **${t.title}** (עדיפות: ${PRIORITY_LABELS_HE[t.priority]})\n` +
          `  ${t.description}\n` +
          (t.dependsOn.length ? `  תלוי ב: ${t.dependsOn.join(', ')}\n` : '') +
          `  הנחה: ${t.assumption}\n` +
          `  סיכון אם ההנחה שגויה: ${t.riskIfAssumptionWrong}`
      )
      .join('\n');
    sections.push(`### ${owner}\n${items}`);
  }
  return sections.join('\n\n');
}

export function renderMarkdown(meeting: Meeting): string {
  const parts: string[] = [];
  parts.push(`> **${DISCLAIMER_HE}**`);
  parts.push(`# ${meeting.title || 'פגישה ללא כותרת'}`);
  parts.push(
    `**מטרה:** ${meeting.objective || '(לא הוגדרה)'}\n\n**סטטוס:** ${STATUS_LABELS_HE[meeting.status]}\n\n**מספר סבבי דיון:** ${meeting.discussionRounds}`
  );

  if (meeting.error) {
    parts.push(`## שגיאה\n${meeting.error}`);
  }

  parts.push(`## תמליל\n\n${renderTranscript(meeting.transcript)}`);

  if (meeting.result) {
    const r = meeting.result;
    parts.push(`## סיכום\n${r.summary}`);
    parts.push(
      `## משימות (מקובצות לפי אחראי)\n\n${renderTasksByOwner(r.tasks)}`
    );
    parts.push(
      `## שאלות פתוחות\n\n${
        r.openQuestions.length
          ? r.openQuestions
              .map((q) => `- ${q.blocking ? '**[חוסמת]** ' : ''}${q.question} (מי אמור לענות: ${q.whoShouldAnswer})`)
              .join('\n')
          : '(אין שאלות פתוחות)'
      }`
    );
    parts.push(
      `## החלטות\n\n${r.decisions.length ? r.decisions.map((d) => `- ${d}`).join('\n') : '(אין החלטות מתועדות)'}`
    );
    parts.push(
      `## התנגשויות\n\n${
        r.conflicts.length ? r.conflicts.map((c) => `- **${c.topic}**: ${c.sides}`).join('\n') : '(לא זוהו התנגשויות)'
      }`
    );
    parts.push(`## סיכונים\n\n${r.risks.length ? r.risks.map((risk) => `- ${risk}`).join('\n') : '(לא זוהו סיכונים)'}`);
    parts.push(
      `## הנחות שהמודל השלים\n\n${
        r.modelAssumptions.length ? r.modelAssumptions.map((a) => `- ${a}`).join('\n') : '(אין הנחות מסומנות)'
      }`
    );
  }

  return parts.join('\n\n') + '\n';
}

/** Triggers a browser download of `content` as `filename`. Revokes the object URL immediately after. */
function downloadBlob(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadMeetingMarkdown(meeting: Meeting): void {
  downloadBlob(renderMarkdown(meeting), `virmeet-meeting-${meeting.id}.md`, 'text/markdown;charset=utf-8');
}

/**
 * `participants` is a name/role-only snapshot of the meeting's personas — not
 * the full `Persona` record (no `prompt`, no `files`). It exists so
 * `scripts/eval-attribution.ts` (docs/PLAN-correctness-and-evaluation.md §6)
 * can run the speaker-attribution eval against an exported meeting without
 * a second export step; nothing else reads it.
 */
export function downloadMeetingJson(meeting: Meeting, participants: Persona[]): void {
  const payload = {
    meeting,
    participants: participants.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  };
  downloadBlob(JSON.stringify(payload, null, 2), `virmeet-meeting-${meeting.id}.json`, 'application/json;charset=utf-8');
}
