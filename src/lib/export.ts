// Virmeet — Markdown/DOCX export renderers + browser download helpers
// (spec §6). The disclaimer banner below must be reproduced verbatim,
// byte-for-byte, as the opening lines of every Markdown export. Moved from
// the old src/app/api/meetings/[id]/export/render.ts as-is; only the
// download mechanism (Blob + object URL, since there's no server route to
// stream from) is new.

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import {
  Meeting,
  MeetingTask,
  Persona,
  TranscriptEntry,
  UNASSIGNED_TASK_OWNER_FALLBACK,
} from './types';

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
    const key = task.ownerName || UNASSIGNED_TASK_OWNER_FALLBACK;
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

  parts.push(
    `## שימוש\n\n` +
      `**קריאות API:** ${meeting.usage.apiCalls}\n\n` +
      `**טוקני קלט:** ${meeting.usage.inputTokens}\n\n` +
      `**טוקני פלט:** ${meeting.usage.outputTokens}\n\n` +
      `**טוקני קריאת cache:** ${meeting.usage.cacheReadTokens}\n\n` +
      `**טוקני כתיבת cache:** ${meeting.usage.cacheWriteTokens}`
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

/** Triggers a browser download of `blob` as `filename`. Revokes the object URL immediately after. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadText(content: string, filename: string, mimeType: string): void {
  downloadBlob(new Blob([content], { type: mimeType }), filename);
}

export function downloadMeetingMarkdown(meeting: Meeting): void {
  downloadText(renderMarkdown(meeting), `virmeet-meeting-${meeting.id}.md`, 'text/markdown;charset=utf-8');
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
  downloadText(JSON.stringify(payload, null, 2), `virmeet-meeting-${meeting.id}.json`, 'application/json;charset=utf-8');
}

// ---------------------------------------------------------------------------
// DOCX export. Same content as the Markdown export, reordered so the
// transcript — the longest, most-reference-only section — is last instead of
// leading, and downloaded automatically once a meeting finishes running (see
// meetings/view/page.tsx).
// ---------------------------------------------------------------------------

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({ text, heading: level, bidirectional: true });
}

/** A run of text split on '\n' into in-paragraph line breaks, so multi-line fields don't collapse onto one line. */
function textLines(text: string, opts: { bold?: boolean; italics?: boolean } = {}): TextRun[] {
  return text.split('\n').map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined, ...opts }));
}

function paragraph(text: string, opts: { bold?: boolean; italics?: boolean } = {}): Paragraph {
  return new Paragraph({ bidirectional: true, children: textLines(text, opts) });
}

function bulletParagraph(text: string, opts: { bold?: boolean } = {}): Paragraph {
  return new Paragraph({ bidirectional: true, bullet: { level: 0 }, children: textLines(text, opts) });
}

function emptyNotice(text: string): Paragraph {
  return paragraph(text, { italics: true });
}

function renderTasksDocx(tasks: MeetingTask[]): Paragraph[] {
  if (tasks.length === 0) return [emptyNotice('(אין משימות)')];
  const grouped = new Map<string, MeetingTask[]>();
  for (const task of tasks) {
    const key = task.ownerName || UNASSIGNED_TASK_OWNER_FALLBACK;
    grouped.set(key, [...(grouped.get(key) ?? []), task]);
  }
  const out: Paragraph[] = [];
  for (const [owner, ownerTasks] of grouped) {
    out.push(heading(owner, HeadingLevel.HEADING_3));
    for (const t of ownerTasks) {
      out.push(bulletParagraph(`${t.title} (עדיפות: ${PRIORITY_LABELS_HE[t.priority]})`, { bold: true }));
      out.push(paragraph(t.description));
      if (t.dependsOn.length) out.push(paragraph(`תלוי ב: ${t.dependsOn.join(', ')}`));
      out.push(paragraph(`הנחה: ${t.assumption}`));
      out.push(paragraph(`סיכון אם ההנחה שגויה: ${t.riskIfAssumptionWrong}`));
    }
  }
  return out;
}

function renderTranscriptDocx(transcript: TranscriptEntry[]): Paragraph[] {
  if (transcript.length === 0) return [emptyNotice('(אין תמליל)')];
  const out: Paragraph[] = [];
  for (const e of transcript) {
    const roundPart = e.round != null ? `, סבב ${e.round}` : '';
    out.push(paragraph(`[${PHASE_LABELS_HE[e.phase]}${roundPart}] ${e.speakerName}`, { bold: true }));
    out.push(paragraph(e.text));
    if (e.webSearches && e.webSearches.length > 0) {
      out.push(paragraph(`חיפושי רשת: ${e.webSearches.map((s) => s.query).join('; ')}`, { italics: true }));
    }
  }
  return out;
}

/** Builds the DOCX document for a meeting. Section order mirrors renderMarkdown, except the transcript moves to the very end. */
export function buildMeetingDocx(meeting: Meeting): Document {
  const children: Paragraph[] = [];

  children.push(paragraph(DISCLAIMER_HE, { italics: true, bold: true }));
  children.push(heading(meeting.title || 'פגישה ללא כותרת', HeadingLevel.TITLE));
  children.push(paragraph(`מטרה: ${meeting.objective || '(לא הוגדרה)'}`));
  children.push(paragraph(`סטטוס: ${STATUS_LABELS_HE[meeting.status]}`));
  children.push(paragraph(`מספר סבבי דיון: ${meeting.discussionRounds}`));

  children.push(heading('שימוש', HeadingLevel.HEADING_2));
  children.push(paragraph(`קריאות API: ${meeting.usage.apiCalls}`));
  children.push(paragraph(`טוקני קלט: ${meeting.usage.inputTokens}`));
  children.push(paragraph(`טוקני פלט: ${meeting.usage.outputTokens}`));
  children.push(paragraph(`טוקני קריאת cache: ${meeting.usage.cacheReadTokens}`));
  children.push(paragraph(`טוקני כתיבת cache: ${meeting.usage.cacheWriteTokens}`));

  if (meeting.error) {
    children.push(heading('שגיאה', HeadingLevel.HEADING_2));
    children.push(paragraph(meeting.error));
  }

  if (meeting.result) {
    const r = meeting.result;

    children.push(heading('סיכום', HeadingLevel.HEADING_2));
    children.push(paragraph(r.summary));

    children.push(heading('משימות (מקובצות לפי אחראי)', HeadingLevel.HEADING_2));
    children.push(...renderTasksDocx(r.tasks));

    children.push(heading('שאלות פתוחות', HeadingLevel.HEADING_2));
    if (r.openQuestions.length === 0) {
      children.push(emptyNotice('(אין שאלות פתוחות)'));
    } else {
      for (const q of r.openQuestions) {
        children.push(
          bulletParagraph(`${q.blocking ? '[חוסמת] ' : ''}${q.question} (מי אמור לענות: ${q.whoShouldAnswer})`)
        );
      }
    }

    children.push(heading('החלטות', HeadingLevel.HEADING_2));
    if (r.decisions.length === 0) {
      children.push(emptyNotice('(אין החלטות מתועדות)'));
    } else {
      for (const d of r.decisions) children.push(bulletParagraph(d));
    }

    children.push(heading('התנגשויות', HeadingLevel.HEADING_2));
    if (r.conflicts.length === 0) {
      children.push(emptyNotice('(לא זוהו התנגשויות)'));
    } else {
      for (const c of r.conflicts) children.push(bulletParagraph(`${c.topic}: ${c.sides}`));
    }

    children.push(heading('סיכונים', HeadingLevel.HEADING_2));
    if (r.risks.length === 0) {
      children.push(emptyNotice('(לא זוהו סיכונים)'));
    } else {
      for (const risk of r.risks) children.push(bulletParagraph(risk));
    }

    children.push(heading('הנחות שהמודל השלים', HeadingLevel.HEADING_2));
    if (r.modelAssumptions.length === 0) {
      children.push(emptyNotice('(אין הנחות מסומנות)'));
    } else {
      for (const a of r.modelAssumptions) children.push(bulletParagraph(a));
    }
  }

  // Transcript last, as the reference appendix rather than the lead section.
  children.push(heading('תמליל הפגישה', HeadingLevel.HEADING_2));
  children.push(...renderTranscriptDocx(meeting.transcript));

  return new Document({
    sections: [{ properties: {}, children }],
  });
}

export async function renderDocxBlob(meeting: Meeting): Promise<Blob> {
  return Packer.toBlob(buildMeetingDocx(meeting));
}

export async function downloadMeetingDocx(meeting: Meeting): Promise<void> {
  const blob = await renderDocxBlob(meeting);
  downloadBlob(blob, `virmeet-meeting-${meeting.id}.docx`);
}
