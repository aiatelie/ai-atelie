// toolKind.test.ts — covers the kindOf() name-categorization map
// for tools coming from Claude SDK (PascalCase), Kimi/OpenCode
// (snake_case), and MCP servers (mcp__server__tool prefix).
//
// Run via `bun test src/lib/toolKind.test.ts`.

import { describe, expect, test } from "bun:test";
import { kindOf, KIND_VERB, KIND_LABEL, type ToolKind } from "./toolKind";

describe("kindOf — Claude SDK PascalCase names", () => {
  test("Read", () => expect(kindOf("Read")).toBe("read"));
  test("Edit", () => expect(kindOf("Edit")).toBe("edit"));
  test("MultiEdit", () => expect(kindOf("MultiEdit")).toBe("edit"));
  test("Write", () => expect(kindOf("Write")).toBe("edit"));
  test("NotebookEdit", () => expect(kindOf("NotebookEdit")).toBe("edit"));
  test("Bash", () => expect(kindOf("Bash")).toBe("execute"));
  test("Glob", () => expect(kindOf("Glob")).toBe("search"));
  test("Grep", () => expect(kindOf("Grep")).toBe("search"));
  test("WebFetch", () => expect(kindOf("WebFetch")).toBe("fetch"));
  test("WebSearch", () => expect(kindOf("WebSearch")).toBe("fetch"));
  test("TodoWrite", () => expect(kindOf("TodoWrite")).toBe("edit"));
});

describe("kindOf — adapter snake_case aliases", () => {
  test("read_file (Kimi/OpenCode)", () => expect(kindOf("read_file")).toBe("read"));
  test("shell (OpenCode)", () => expect(kindOf("shell")).toBe("execute"));
  test("run_command", () => expect(kindOf("run_command")).toBe("execute"));
  test("web_search", () => expect(kindOf("web_search")).toBe("fetch"));
  test("rg (alt grep)", () => expect(kindOf("rg")).toBe("search"));
});

describe("kindOf — MCP prefix tolerated", () => {
  test("mcp__starters__copy_starter → edit", () => {
    expect(kindOf("mcp__starters__copy_starter")).toBe("edit");
  });
  test("mcp__starters__list_starters → read", () => {
    expect(kindOf("mcp__starters__list_starters")).toBe("read");
  });
  test("mcp__custom__bash → execute", () => {
    expect(kindOf("mcp__custom__bash")).toBe("execute");
  });
});

describe("kindOf — case-insensitive", () => {
  test("read (lowercase) === Read (PascalCase)", () => {
    expect(kindOf("read")).toBe(kindOf("Read"));
  });
  test("BASH (uppercase)", () => {
    expect(kindOf("BASH")).toBe("execute");
  });
});

describe("kindOf — fallback for unknown / interaction tools", () => {
  test("unknown tool → other", () => {
    expect(kindOf("FooBar")).toBe("other");
  });
  test("ask_user (interaction, NOT edit) → other", () => {
    // ask_user is not file-writing; the isEmptyProject check in
    // Editor.tsx must NOT count it as an edit. Failing this test
    // would silently corrupt that check.
    expect(kindOf("ask_user")).toBe("other");
    expect(kindOf("mcp__ask-user__ask_user")).toBe("other");
  });
  test("empty / null / undefined → other", () => {
    expect(kindOf("")).toBe("other");
    expect(kindOf(null)).toBe("other");
    expect(kindOf(undefined)).toBe("other");
  });
});

describe("KIND_VERB — every kind has a verb", () => {
  const KINDS: ToolKind[] = ["read", "edit", "execute", "fetch", "search", "other"];
  for (const kind of KINDS) {
    test(`${kind} → has verb`, () => {
      expect(KIND_VERB[kind]).toBeTruthy();
      expect(typeof KIND_VERB[kind]).toBe("string");
    });
  }
});

describe("KIND_LABEL — every kind has a label", () => {
  const KINDS: ToolKind[] = ["read", "edit", "execute", "fetch", "search", "other"];
  for (const kind of KINDS) {
    test(`${kind} → has label`, () => {
      expect(KIND_LABEL[kind]).toBeTruthy();
    });
  }
});
