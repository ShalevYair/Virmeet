// Virmeet — Markdown export renderer (spec §6).
// The disclaimer banner below must be reproduced verbatim, byte-for-byte,
// as the opening lines of every Markdown export.

import { Meeting, MeetingTask, TranscriptEntry } from '@/lib/types';
import { formatUsd } from '@/lib/pricing';

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

function renderWebSearches(webSearches: NonNullable<TranscriptEntry['webSearches']>): string {
  const lines = webSearches.map((s) => {
    if (s.error) return `- "${s.query}" — ${s.error}`;
    if (s.results && s.results.length > 0) {
      const links = s.results.map((r) => `[${r.title}](${r.url})`).join(', ');
      return `- "${s.query}" — מקורות: ${links}`;
    }
    return `- "${s.query}"`;
  });
  return `\n\n_חיפושי רשת:_\n${lines.join('\n')}`;
}

function renderTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return '(אין תמליל)';
  return transcript
    .map((e) => {
      const roundPart = e.round != null ? `, סבב ${e.round}` : '';
      const searches = e.webSearches && e.webSearches.length > 0 ? renderWebSearches(e.webSearches) : '';
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

  if (meeting.usage.apiCalls > 0) {
    const u = meeting.usage;
    const totalTokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    const cacheReadPct = totalTokens > 0 ? Math.round((u.cacheReadTokens / totalTokens) * 100) : 0;
    parts.push(
      `## שימוש ועלות\n\n` +
        `- קריאות מודל: ${u.apiCalls}\n` +
        `- טוקני קלט: ${u.inputTokens.toLocaleString('he-IL')}\n` +
        `- טוקני פלט: ${u.outputTokens.toLocaleString('he-IL')}\n` +
        `- טוקני cache שנקראו: ${u.cacheReadTokens.toLocaleString('he-IL')} (${cacheReadPct}% מסך הטוקנים)\n` +
        `- טוקני cache שנכתבו: ${u.cacheCreationTokens.toLocaleString('he-IL')}\n` +
        `- **עלות מוערכת: ${formatUsd(u.costUsd)}** (הערכה בלבד, מבוססת על מחירון קבוע בקוד שעשוי להשתנות — לא חיוב בפועל)`
    );
  }

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
