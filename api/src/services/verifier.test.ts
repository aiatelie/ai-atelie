/* verifier.test.ts — pure-helper tests for the verifier subagent.
 *
 * Network/SDK calls are not exercised; we validate the silent-pass /
 * has-findings discriminator and the user-message builder so a future
 * refactor doesn't accidentally start surfacing "looks good" noise.
 */

import { describe, expect, it } from "bun:test";
import { __TEST__ } from "./verifier.ts";

const { hasFindings, buildVerifierUserMessage, VERIFIER_SYSTEM_PROMPT } = __TEST__;

describe("verifier.hasFindings", () => {
  it("treats exact OK as pass", () => {
    expect(hasFindings("OK")).toBe(false);
    expect(hasFindings("OK ")).toBe(false);
    expect(hasFindings("OK.")).toBe(false);
    expect(hasFindings("\nOK\n")).toBe(false);
  });

  it("treats common false-positives as pass", () => {
    expect(hasFindings("looks good")).toBe(false);
    expect(hasFindings("Looks Good")).toBe(false);
    expect(hasFindings("Looks good.")).toBe(false);         // trailing period
    expect(hasFindings("All looks good!")).toBe(false);    // prefix + punctuation
    expect(hasFindings("Everything looks good.")).toBe(false);
    expect(hasFindings("no issues found")).toBe(false);
    expect(hasFindings("No issues found.")).toBe(false);   // capitalized + period
    expect(hasFindings("No issues.")).toBe(false);         // "no issues" substring
    expect(hasFindings("all good")).toBe(false);
    expect(hasFindings("The files all look syntactically valid.")).toBe(false);
    expect(hasFindings("Everything is fine.")).toBe(false);
    expect(hasFindings("No errors.")).toBe(false);
    expect(hasFindings("No problems found.")).toBe(false);
  });

  it("treats empty / whitespace as pass", () => {
    expect(hasFindings("")).toBe(false);
    expect(hasFindings("   \n  ")).toBe(false);
  });

  it("flags warnings prefixed with the alert glyph", () => {
    expect(hasFindings("⚠ Banner.jsx imports './missing-file'")).toBe(true);
  });

  it("flags multi-line warning lists", () => {
    const text = "⚠ Banner.jsx: unclosed JSX fragment\n⚠ style.css: missing closing brace";
    expect(hasFindings(text)).toBe(true);
  });

  it("flags any non-OK non-noise free text as findings (defensive)", () => {
    expect(hasFindings("Banner.jsx has a syntax error on line 12")).toBe(true);
  });

  it("rejects 'OK, but ...' — partial OK is not a clean pass", () => {
    expect(hasFindings("OK, but watch out for…")).toBe(true);
  });
});

describe("verifier.buildVerifierUserMessage", () => {
  it("includes the file count and a path manifest", () => {
    const msg = buildVerifierUserMessage([
      { path: "Banner.jsx", contents: "export default () => <div />;" },
      { path: "style.css", contents: ".a { color: red; }" },
    ]);
    expect(msg).toContain("2 file(s)");
    expect(msg).toContain("- Banner.jsx");
    expect(msg).toContain("- style.css");
    expect(msg).toContain("=== Banner.jsx ===");
    expect(msg).toContain("=== style.css ===");
  });

  it("truncates oversize file contents with a marker", () => {
    const big = "x".repeat(20_000);
    const msg = buildVerifierUserMessage([{ path: "huge.css", contents: big }]);
    expect(msg).toContain("(truncated, full length 20000)");
    // Sanity: doesn't ship the entire file.
    expect(msg.length).toBeLessThan(20_000 + 500);
  });
});

describe("verifier.system prompt", () => {
  it("matches the canonical QA prompt verbatim", () => {
    // Sentinel — surfaces if anyone edits the system prompt without
    // updating the contract documented in the route handler.
    expect(VERIFIER_SYSTEM_PROMPT).toContain("silent QA verifier");
    expect(VERIFIER_SYSTEM_PROMPT).toContain("respond with exactly: OK");
    expect(VERIFIER_SYSTEM_PROMPT).toContain('prefixed with "⚠ "');
  });
});
