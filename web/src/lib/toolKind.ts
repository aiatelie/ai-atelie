/* toolKind.ts — semantic categorization of tool-call names.
 *
 * Used by ChatSidebar's ToolChip + LiveStatus + Editor's
 * isEmptyProject check to render tool calls with kind-coded colors,
 * verbs, and to decide which tools count as "this project has files
 * in it now". Single source of truth so the call sites stay aligned.
 *
 * The map is alias-aware (case-insensitive, MCP prefix tolerated,
 * snake_case aliases listed) so it covers Claude SDK, MCP servers,
 * OpenCode, and Kimi tool names without per-adapter forks.
 */

export type ToolKind =
  | "read"
  | "edit"
  | "execute"
  | "fetch"
  | "search"
  | "other";

const KIND_BY_NAME: Record<string, ToolKind> = {
  // ─── read ────────────────────────────────────────────────
  read: "read",
  read_file: "read",
  view: "read",
  cat: "read",
  ls: "read",
  list_starters: "read", // mcp__starters__list_starters

  // ─── edit (write/modify files) ───────────────────────────
  // Strictly file-writing tools — `kindOf(name) === "edit"` is also
  // used by Editor.tsx to detect when a project is no longer empty.
  // Interaction-style tools like ask_user fall through to "other".
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  str_replace_editor: "edit",
  str_replace_based_edit_tool: "edit",
  replace: "edit",
  todowrite: "edit",
  copy_starter: "edit", // mcp__starters__copy_starter creates a file

  // ─── execute (run code / shell) ──────────────────────────
  bash: "execute",
  shell: "execute",
  run: "execute",
  run_command: "execute",

  // ─── fetch (network I/O) ─────────────────────────────────
  webfetch: "fetch",
  fetch: "fetch",
  curl: "fetch",
  web_get: "fetch",
  websearch: "fetch",
  web_search: "fetch",

  // ─── search (looking through code) ───────────────────────
  grep: "search",
  glob: "search",
  find: "search",
  rg: "search",
};

/** Strip MCP prefix (`mcp__server__tool` → `tool`) and lowercase
 *  for case-insensitive lookup. Tools from real Claude (`Read`),
 *  Kimi (`read_file`), OpenCode (`shell`), and MCP
 *  (`mcp__ask-user__ask_user`) all converge on the same lookup key. */
function normalizeName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, "");
  return stripped.toLowerCase();
}

export function kindOf(name: string | null | undefined): ToolKind {
  if (!name) return "other";
  return KIND_BY_NAME[normalizeName(name)] ?? "other";
}

/** Human-friendly verb per kind. Used in `LiveStatus`'s "Reading X…"
 *  preview line so the verb stays consistent with the chip color. */
export const KIND_VERB: Record<ToolKind, string> = {
  read: "Reading",
  edit: "Editing",
  execute: "Running",
  fetch: "Fetching",
  search: "Searching",
  other: "Working",
};

/** Per-tool semantic verb overrides. More specific than KIND_VERB —
 *  takes precedence when present. The goal is to replace generic
 *  "Working" with something the user can read at a glance and
 *  understand (e.g. "Asking" instead of "Working" for ask_user). */
const TOOL_VERB: Record<string, string> = {
  // Interaction
  ask_user: "Asking",
  // Todos
  todowrite: "Updating todos",
  todoread: "Reading todos",
  update_todos: "Updating todos",
  // Starters / scaffolding
  copy_starter: "Copying starter",
  list_starters: "Listing starters",
  // Filesystem (more specific than kind)
  list_files: "Listing files",
  ls: "Listing files",
  glob: "Finding files",
  // Web
  web_search: "Searching the web",
  websearch: "Searching the web",
  web_fetch: "Fetching",
  webfetch: "Fetching",
};

/** Resolve the most-specific verb for a tool. Per-tool override wins,
 *  then per-kind verb, then "Working". */
export function verbOf(name: string | null | undefined): string {
  if (!name) return "Working";
  const normalized = name.replace(/^mcp__[^_]+__/, "").toLowerCase();
  return TOOL_VERB[normalized] ?? KIND_VERB[kindOf(name)];
}

/** Stable label per kind, used for screen-reader hints and
 *  occasional debug output. */
export const KIND_LABEL: Record<ToolKind, string> = {
  read: "read",
  edit: "edit",
  execute: "execute",
  fetch: "fetch",
  search: "search",
  other: "tool",
};
