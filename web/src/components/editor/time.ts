/* time.ts — chat-friendly time helpers shared by the message stream
 * (day separators, relative timestamps) and the bubble metadata row.
 * Pure functions only; intentionally no React import so they can be
 * unit-tested without a renderer. */

const MS_IN_MINUTE = 60_000;
const MS_IN_HOUR = 3_600_000;
const MS_IN_DAY = 86_400_000;

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

const FULL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Local-day key (YYYY-MM-DD) for grouping messages that share a date.
 *  Uses the user's local timezone via Date so a message at 11:55pm and
 *  one at 12:05am don't collapse onto the same key. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whether a separator should render between two adjacent messages. */
export function shouldShowDaySeparator(prevTs: number | undefined, currTs: number): boolean {
  if (prevTs === undefined) return false;
  return dayKey(prevTs) !== dayKey(currTs);
}

/** Display label for a day separator: Today / Yesterday / Mon, Jan 15. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const k = dayKey(ts);
  const todayK = dayKey(now);
  if (k === todayK) return "Today";
  if (k === dayKey(now - MS_IN_DAY)) return "Yesterday";
  return SHORT_DATE.format(new Date(ts));
}

/** Relative time for the bubble byline. Returns coarse buckets so the
 *  string doesn't dance around: "just now", "12m ago", "3h ago",
 *  "Yesterday", or the short date for anything older. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < MS_IN_MINUTE) return "just now";
  if (diff < MS_IN_HOUR) {
    const m = Math.floor(diff / MS_IN_MINUTE);
    return `${m}m ago`;
  }
  if (diff < MS_IN_DAY) {
    const h = Math.floor(diff / MS_IN_HOUR);
    return `${h}h ago`;
  }
  if (diff < 2 * MS_IN_DAY && dayKey(ts) === dayKey(now - MS_IN_DAY)) {
    return "Yesterday";
  }
  return SHORT_DATE.format(new Date(ts));
}

/** Full date+time string used as a `title` attribute on the bubble so
 *  hovering the relative label reveals the exact moment. */
export function fullDateTime(ts: number): string {
  return FULL_DATE_TIME.format(new Date(ts));
}
