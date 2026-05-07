// detectFileExtension.test.ts — covers the heuristics that pick an
// extension for a pasted blob: JSON, SVG, HTML, markdown, CSS, TS, JS,
// and the .txt fallback.
//
// Run via `bun test src/components/editor/detectFileExtension.test.ts`.

import { describe, expect, test } from "bun:test";
import { detectFileExtension, suggestPasteFilename } from "./detectFileExtension";

describe("detectFileExtension — happy paths", () => {
  test("empty string → txt", () => {
    expect(detectFileExtension("")).toBe("txt");
  });

  test("JSON object", () => {
    expect(detectFileExtension(`{ "a": 1 }`)).toBe("json");
  });

  test("JSON array", () => {
    expect(detectFileExtension(`[1, 2, 3]`)).toBe("json");
  });

  test("JSON-like but invalid → falls through, not classified as json", () => {
    expect(detectFileExtension("{ not really json }")).not.toBe("json");
  });

  test("HTML doctype", () => {
    expect(detectFileExtension("<!DOCTYPE html><html><body>x</body></html>")).toBe("html");
  });

  test("HTML root tag", () => {
    expect(detectFileExtension("<html><body>x</body></html>")).toBe("html");
  });

  test("Generic tag-pair → html", () => {
    expect(detectFileExtension("<div>hi</div>")).toBe("html");
  });

  test("SVG with xml prolog", () => {
    expect(detectFileExtension(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toBe("svg");
  });

  test("SVG without prolog", () => {
    expect(detectFileExtension(`<svg viewBox="0 0 10 10"></svg>`)).toBe("svg");
  });

  test("Markdown heading", () => {
    expect(detectFileExtension("# Hello\nworld")).toBe("md");
  });

  test("Markdown fenced code", () => {
    expect(detectFileExtension("```ts\nx\n```")).toBe("md");
  });

  test("Markdown bullet list (multiline)", () => {
    expect(detectFileExtension("- one\n- two")).toBe("md");
  });

  test("CSS @media", () => {
    expect(detectFileExtension("@media (max-width: 600px) { .x { color: red; } }")).toBe("css");
  });

  test("CSS rule", () => {
    expect(detectFileExtension(".foo { color: red; }")).toBe("css");
  });

  test("TypeScript interface", () => {
    expect(detectFileExtension("export interface Foo { a: number }")).toBe("ts");
  });

  test("TypeScript type alias", () => {
    expect(detectFileExtension("type Foo = string;")).toBe("ts");
  });

  test("JavaScript const", () => {
    expect(detectFileExtension("const x = 1;\nexport default x;")).toBe("js");
  });

  test("Plain prose → txt", () => {
    expect(detectFileExtension("just some notes I scribbled down")).toBe("txt");
  });
});

describe("suggestPasteFilename", () => {
  test("uses detected extension", () => {
    const NOW = new Date("2026-05-07T03:48:00Z").getTime();
    expect(suggestPasteFilename(`{ "a": 1 }`, NOW)).toMatch(/^paste-\d{10}\.json$/);
  });

  test("falls back to txt for plain prose", () => {
    expect(suggestPasteFilename("hello there")).toMatch(/\.txt$/);
  });
});
