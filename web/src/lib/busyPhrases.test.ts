import { test, expect } from "bun:test";
import { pickBusyPhrase } from "./busyPhrases";

test("returns a non-empty string", () => {
  const p = pickBusyPhrase();
  expect(typeof p).toBe("string");
  expect(p.length).toBeGreaterThan(0);
});

test("returns multiple distinct phrases over many calls", () => {
  // With ~24 phrases, 50 calls should hit at least 4 distinct values.
  // (The non-repeat-consecutive rule guarantees ≥2; this confirms the
  // pool actually rotates beyond a stuck pair.)
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(pickBusyPhrase());
  expect(seen.size).toBeGreaterThanOrEqual(4);
});

test("never repeats the same phrase twice in a row", () => {
  let prev = pickBusyPhrase();
  for (let i = 0; i < 200; i++) {
    const next = pickBusyPhrase();
    expect(next).not.toBe(prev);
    prev = next;
  }
});
