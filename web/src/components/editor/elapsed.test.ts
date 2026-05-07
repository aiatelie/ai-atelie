// elapsed.test.ts — formatElapsed bound + format coverage.
// Run via `bun test src/components/editor/elapsed.test.ts`.

import { describe, expect, test } from "bun:test";
import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  test("zero → 0.0s", () => {
    expect(formatElapsed(0)).toBe("0.0s");
  });

  test("sub-second rounds to one decimal", () => {
    expect(formatElapsed(0.234)).toBe("0.2s");
    expect(formatElapsed(0.96)).toBe("1.0s");
  });

  test("multi-second under a minute keeps one decimal", () => {
    expect(formatElapsed(12.345)).toBe("12.3s");
    expect(formatElapsed(59.9)).toBe("59.9s");
  });

  test("one minute pivots to m/s format", () => {
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(64)).toBe("1m 04s");
    expect(formatElapsed(125.7)).toBe("2m 05s");
  });

  test("seconds stay zero-padded", () => {
    expect(formatElapsed(61)).toBe("1m 01s");
  });

  test("negative input clamps to 0", () => {
    expect(formatElapsed(-3)).toBe("0.0s");
  });
});
