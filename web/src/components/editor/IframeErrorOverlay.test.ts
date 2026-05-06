// IframeErrorOverlay.test.ts — covers the pure helpers exported from
// IframeErrorOverlay.tsx (formatErrorForChat, stripOrigin). React-state
// behaviour (throttle, auto-dismiss) is exercised by the e2e spec at
// `web/tests/e2e/iframe-error-overlay.spec.ts` since bun:test has no DOM.

import { describe, expect, test } from "bun:test";
import { formatErrorForChat, stripOrigin } from "./IframeErrorOverlay";

describe("stripOrigin", () => {
  test("trims dev origin from absolute URL", () => {
    expect(stripOrigin("http://localhost:5173/p/my-proj/index.html"))
      .toBe("/p/my-proj/index.html");
  });
  test("preserves query string", () => {
    expect(stripOrigin("http://localhost:5173/p/my-proj/index.html?v=2"))
      .toBe("/p/my-proj/index.html?v=2");
  });
  test("returns input verbatim if not a URL", () => {
    expect(stripOrigin("inline-script")).toBe("inline-script");
    expect(stripOrigin("")).toBe("");
  });
  test("survives https + non-default port", () => {
    expect(stripOrigin("https://example.test:8443/foo/bar.js"))
      .toBe("/foo/bar.js");
  });
});

describe("formatErrorForChat", () => {
  test("synchronous error with file:line:col", () => {
    const out = formatErrorForChat({
      message: "TypeError: x is undefined",
      filename: "http://localhost:5173/p/demo/main.js",
      lineno: 42,
      colno: 7,
      stack: "Error\n  at foo (main.js:42:7)",
      source: "error",
    });
    expect(out).toContain("Iframe runtime error:");
    expect(out).toContain("TypeError: x is undefined");
    expect(out).toContain("at /p/demo/main.js:42:7");
    expect(out).toContain("at foo (main.js:42:7)");
    // Wrapped in a fenced code block.
    expect(out.startsWith("Iframe runtime error:\n```\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
  });

  test("unhandledrejection prefix is added", () => {
    const out = formatErrorForChat({
      message: "Network down",
      filename: null,
      lineno: null,
      colno: null,
      stack: null,
      source: "unhandledrejection",
    });
    expect(out).toContain("[unhandledrejection] Network down");
    // No `at ...` line when filename missing.
    expect(out).not.toMatch(/^at\s/m);
  });

  test("missing stack omits the trace block but keeps the message", () => {
    const out = formatErrorForChat({
      message: "Plain throw",
      filename: "http://localhost:5173/p/demo/inline",
      lineno: 1,
      colno: null,
      stack: null,
      source: "error",
    });
    expect(out).toContain("Plain throw");
    expect(out).toContain("at /p/demo/inline:1");
    // Should still be a valid fenced block.
    const fences = (out.match(/```/g) || []).length;
    expect(fences).toBe(2);
  });

  test("filename without lineno still appears in `at`", () => {
    const out = formatErrorForChat({
      message: "Boom",
      filename: "http://localhost:5173/p/x/index.html",
      lineno: null,
      colno: null,
      stack: null,
      source: "error",
    });
    expect(out).toContain("at /p/x/index.html");
  });
});
