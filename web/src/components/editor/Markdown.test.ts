// Markdown.test.ts — covers the inline-parser additions in Phase D of
// issue #43: bare-URL autolinks + a second pass that doesn't touch text
// already wrapped in markdown link syntax, code, bold, or italic.
//
// Run via `bun test src/components/editor/Markdown.test.ts`.

import { describe, expect, test } from "bun:test";
import { parseInline, type InlineNode } from "./Markdown";

function autolinks(nodes: InlineNode[]): string[] {
  return nodes.filter((n) => n.type === "autolink").map((n) => n.href);
}

describe("parseInline — bare-URL autolinks", () => {
  test("plain http URL becomes an autolink", () => {
    const out = parseInline("see http://example.com for details");
    expect(autolinks(out)).toEqual(["http://example.com"]);
  });

  test("plain https URL becomes an autolink", () => {
    const out = parseInline("see https://example.com for details");
    expect(autolinks(out)).toEqual(["https://example.com"]);
  });

  test("trailing period is left in surrounding text", () => {
    const out = parseInline("Visit https://example.com.");
    expect(autolinks(out)).toEqual(["https://example.com"]);
    const last = out[out.length - 1];
    expect(last.type).toBe("text");
    if (last.type === "text") expect(last.value).toBe(".");
  });

  test("trailing comma is left in surrounding text", () => {
    const out = parseInline("see https://example.com, and others");
    expect(autolinks(out)).toEqual(["https://example.com"]);
  });

  test("trailing closing-paren is left in surrounding text", () => {
    const out = parseInline("(see https://example.com)");
    expect(autolinks(out)).toEqual(["https://example.com"]);
    const last = out[out.length - 1];
    expect(last.type).toBe("text");
    if (last.type === "text") expect(last.value).toBe(")");
  });

  test("multiple URLs in one paragraph", () => {
    const out = parseInline("first https://a.example then https://b.example");
    expect(autolinks(out)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("URL with path and query is captured whole", () => {
    const out = parseInline("docs at https://example.com/a/b?x=1&y=2 here");
    expect(autolinks(out)).toEqual(["https://example.com/a/b?x=1&y=2"]);
  });

  test("paragraph without any URL contains no autolink nodes", () => {
    const out = parseInline("just some plain text");
    expect(autolinks(out)).toEqual([]);
  });
});

describe("parseInline — autolinks don't clobber existing markdown", () => {
  test("explicit [text](href) link is preserved as a link, not an autolink", () => {
    const out = parseInline("see [docs](https://example.com)");
    expect(autolinks(out)).toEqual([]);
    const link = out.find((n) => n.type === "link");
    expect(link).toBeDefined();
    if (link && link.type === "link") {
      expect(link.href).toBe("https://example.com");
      expect(link.text).toBe("docs");
    }
  });

  test("URL inside backtick code stays in the code node", () => {
    const out = parseInline("run `curl https://example.com` now");
    expect(autolinks(out)).toEqual([]);
    const code = out.find((n) => n.type === "code");
    expect(code).toBeDefined();
    if (code && code.type === "code") {
      expect(code.value).toBe("curl https://example.com");
    }
  });

  test("URL inside bold text stays in the bold node", () => {
    const out = parseInline("**visit https://example.com today**");
    expect(autolinks(out)).toEqual([]);
    const bold = out.find((n) => n.type === "bold");
    expect(bold).toBeDefined();
  });
});
