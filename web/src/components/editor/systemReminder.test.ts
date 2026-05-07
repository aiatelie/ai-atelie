// systemReminder.test.ts — splitter coverage:
// - plain text passes through unchanged
// - one reminder block splits into [text, reminder, text]
// - multiple reminders preserve order
// - orphan opening/closing tags get stripped
// - empty/whitespace-only text segments are dropped
// - reminder body is trimmed
//
// Run via `bun test src/components/editor/systemReminder.test.ts`.

import { describe, expect, test } from "bun:test";
import { previewReminder, splitSystemReminders } from "./systemReminder";

describe("splitSystemReminders", () => {
  test("returns [] for empty input", () => {
    expect(splitSystemReminders("")).toEqual([]);
  });

  test("plain text becomes a single text segment", () => {
    const out = splitSystemReminders("hello world");
    expect(out).toEqual([{ kind: "text", text: "hello world" }]);
  });

  test("single reminder splits into text + reminder + text", () => {
    const input = "before <system-reminder>note here</system-reminder> after";
    const out = splitSystemReminders(input);
    expect(out).toEqual([
      { kind: "text", text: "before " },
      { kind: "reminder", text: "note here" },
      { kind: "text", text: " after" },
    ]);
  });

  test("multiple reminders preserve order", () => {
    const input = "a<system-reminder>r1</system-reminder>b<system-reminder>r2</system-reminder>c";
    const kinds = splitSystemReminders(input).map((s) => s.kind);
    expect(kinds).toEqual(["text", "reminder", "text", "reminder", "text"]);
  });

  test("reminder body is trimmed", () => {
    const out = splitSystemReminders("<system-reminder>\n  body  \n</system-reminder>");
    expect(out).toEqual([{ kind: "reminder", text: "body" }]);
  });

  test("orphan opening tag in text is stripped", () => {
    const out = splitSystemReminders("hello <system-reminder> world");
    expect(out).toEqual([{ kind: "text", text: "hello  world" }]);
  });

  test("orphan closing tag in text is stripped", () => {
    const out = splitSystemReminders("hello </system-reminder> world");
    expect(out).toEqual([{ kind: "text", text: "hello  world" }]);
  });

  test("whitespace-only text segments are dropped", () => {
    const out = splitSystemReminders("   <system-reminder>note</system-reminder>   ");
    expect(out).toEqual([{ kind: "reminder", text: "note" }]);
  });

  test("multiline reminder body is preserved", () => {
    const input = "<system-reminder>line one\nline two</system-reminder>";
    expect(splitSystemReminders(input)).toEqual([
      { kind: "reminder", text: "line one\nline two" },
    ]);
  });

  test("case-insensitive tag match", () => {
    const out = splitSystemReminders("<SYSTEM-REMINDER>up</SYSTEM-REMINDER>");
    expect(out).toEqual([{ kind: "reminder", text: "up" }]);
  });
});

describe("previewReminder", () => {
  test("returns short body unchanged", () => {
    expect(previewReminder("short")).toBe("short");
  });
  test("truncates with ellipsis past max", () => {
    expect(previewReminder("a".repeat(200), 50)).toBe("a".repeat(49) + "…");
  });
  test("uses only the first line", () => {
    expect(previewReminder("first line\nsecond line")).toBe("first line");
  });
});
