// time.test.ts — chat time helpers: dayKey, shouldShowDaySeparator,
// dayLabel, relativeTime.
//
// These tests pin a fixed `now` so the buckets are deterministic
// regardless of when the suite runs. Intl formatters are exercised
// only via dayLabel/relativeTime fallthrough (older dates) so the
// assertion just checks "non-empty string" for those branches.
//
// Run via `bun test src/components/editor/time.test.ts`.

import { describe, expect, test } from "bun:test";
import {
  dayKey,
  dayLabel,
  relativeTime,
  shouldShowDaySeparator,
} from "./time";

const NOW = new Date("2026-05-07T14:00:00").getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("dayKey", () => {
  test("formats as YYYY-MM-DD in local tz", () => {
    expect(dayKey(NOW)).toBe("2026-05-07");
  });

  test("two timestamps on the same calendar day share a key", () => {
    const morning = new Date("2026-05-07T01:00:00").getTime();
    const evening = new Date("2026-05-07T23:30:00").getTime();
    expect(dayKey(morning)).toBe(dayKey(evening));
  });

  test("midnight crossings produce different keys", () => {
    const before = new Date("2026-05-07T23:55:00").getTime();
    const after = new Date("2026-05-08T00:05:00").getTime();
    expect(dayKey(before)).not.toBe(dayKey(after));
  });
});

describe("shouldShowDaySeparator", () => {
  test("never shows for the very first message", () => {
    expect(shouldShowDaySeparator(undefined, NOW)).toBe(false);
  });
  test("hides when adjacent messages share a day", () => {
    expect(shouldShowDaySeparator(NOW - HOUR, NOW)).toBe(false);
  });
  test("shows when adjacent messages cross midnight", () => {
    expect(shouldShowDaySeparator(NOW - DAY, NOW)).toBe(true);
  });
});

describe("dayLabel", () => {
  test("today → 'Today'", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
  });
  test("yesterday → 'Yesterday'", () => {
    expect(dayLabel(NOW - DAY, NOW)).toBe("Yesterday");
  });
  test("older → non-empty short-date string", () => {
    const out = dayLabel(NOW - 7 * DAY, NOW);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(["Today", "Yesterday"]).not.toContain(out);
  });
});

describe("relativeTime", () => {
  test("under 1 minute → 'just now'", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
  });
  test("12 minutes → '12m ago'", () => {
    expect(relativeTime(NOW - 12 * MIN, NOW)).toBe("12m ago");
  });
  test("3 hours → '3h ago'", () => {
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3h ago");
  });
  test("yesterday → 'Yesterday'", () => {
    expect(relativeTime(NOW - DAY, NOW)).toBe("Yesterday");
  });
  test("older → falls back to short date", () => {
    const out = relativeTime(NOW - 30 * DAY, NOW);
    expect(out).not.toBe("Yesterday");
    expect(out.length).toBeGreaterThan(0);
  });
});
