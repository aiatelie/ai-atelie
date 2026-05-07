/* systemReminder.ts — split chat content into prose vs. reminder
 * segments. Models occasionally echo `<system-reminder>...</system-reminder>`
 * blocks back into their replies; rendering them as raw text leaks
 * harness internals into the user-visible thread. The splitter pulls
 * those blocks out so the bubble can render them as an opt-in
 * collapsible while leaving the surrounding prose intact. */

export type ReminderSegment =
  | { kind: "text"; text: string }
  | { kind: "reminder"; text: string };

const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
const ORPHAN_OPEN_RE = /<system-reminder>/gi;
const ORPHAN_CLOSE_RE = /<\/system-reminder>/gi;

/** Split input into ordered segments. Empty text segments (zero-length
 *  after trimming) are dropped. Orphan tags in text segments are
 *  stripped. The output preserves segment order so the caller can
 *  render directly into a sequence. */
export function splitSystemReminders(input: string): ReminderSegment[] {
  if (!input) return [];

  const segments: ReminderSegment[] = [];
  let cursor = 0;
  REMINDER_RE.lastIndex = 0;

  for (;;) {
    const match = REMINDER_RE.exec(input);
    if (!match) break;
    const before = input.slice(cursor, match.index);
    pushText(segments, before);
    segments.push({ kind: "reminder", text: match[1].trim() });
    cursor = match.index + match[0].length;
  }

  pushText(segments, input.slice(cursor));
  return segments;
}

function pushText(out: ReminderSegment[], chunk: string): void {
  if (!chunk) return;
  const cleaned = chunk.replace(ORPHAN_OPEN_RE, "").replace(ORPHAN_CLOSE_RE, "");
  if (!cleaned.trim()) return;
  out.push({ kind: "text", text: cleaned });
}

/** Truncate a reminder body for the collapsed summary preview. Keeps
 *  the first line, caps to `max` characters, appends an ellipsis when
 *  truncated. */
export function previewReminder(body: string, max = 120): string {
  const firstLine = body.split(/\r?\n/)[0] ?? "";
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1).trimEnd() + "…";
}
