/* types.ts — payload shapes shared between the comment-edit route, the
 * prompt builder, and both AI provider drivers. */

export type Attachment = { dataUrl: string; name: string };

/** Mirrors `ElementDescriptor` in web/src/lib/cssPath.ts. The server
 *  doesn't import from src/, so we redefine the shape here. Optional
 *  fields stay optional — older clients won't send a descriptor. */
export type ElementDescriptor = {
  label: string;
  tag: string;
  text?: string;
  classes: string[];
  id?: string;
  role?: string;
  ariaLabel?: string;
  testId?: string;
  attrs?: Record<string, string>;
  ancestors: string[];
  siblingIndex?: number;
  siblingTotal?: number;
};

export type CommentPayload = {
  route: string;
  selector: string;
  comment: string;
  tag?: string;
  innerText?: string;
  outerHtml?: string;
  /** Rich element profile — preferred over bare `selector` + `tag`. */
  descriptor?: ElementDescriptor;
  /** data:image/png;base64,... */
  screenshotDataUrl?: string;
  /** Extra images the user pasted/dropped into the bubble. */
  attachments?: Attachment[];
  /** Stable per-editor session id; both providers resume context via this. */
  sessionId?: string;
  /** Per-message model id (e.g. "kimi-code/kimi-for-coding", "claude-opus-4-7"). */
  modelId?: string;
  /** Sandbox project id. When set, AI is scoped to PROJECTS_ROOT/<id>/.
   *  Without this we fall through to the legacy LEGACY_EDITOR_ROOT access. */
  projectId?: string;
  /** When set, the AI is told to ONLY edit this single file (component canvas mode). */
  scopeFile?: string;
  /** Client-generated stream id (chatStream.newStreamId). When present
   *  AND well-formed, the server uses it as the registry key so a
   *  reloaded client can resume via GET /api/comment-edit/replay/:streamId.
   *  Legacy clients omit this and the server falls back to randomUUID()
   *  (no replay possible — preserves prior behavior). */
  streamId?: string;
};

export type Emitter = (event: string, data: unknown) => void;

/* ─── Provider-agnostic agent event stream ───────────────────────
 *
 * Every provider adapter (Claude SDK, kimi spawn, future adapters)
 * emits one of these. Consumers — the frontend chat decoder, the
 * persistence shadow, the run logger — only ever deal with this
 * shape. They never see SDK frames or kimi stream-json lines.
 *
 * Orchestration events (status / elicit / error / done / turnId)
 * stay on their existing channels, emitted by commentEdit.ts. The
 * `agent` channel is content-only.
 */

export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  durationMs?: number;
  model?: string;
};

export type AgentToolCall = {
  /** Provider's tool_use_id when available, so toolResult events
   *  can match back to the originating tool. The Anthropic SDK
   *  emits this; kimi --print stream-json does not. */
  id?: string;
  name: string;
  input?: Record<string, unknown>;
};

export type AgentEvent =
  | { type: "text"; chunk: string }
  /** The full final assistant text, when the provider emits one
   *  (Claude SDK `result`). Frontend dedupes against streamed deltas. */
  | { type: "finalText"; chunk: string }
  | { type: "thinking"; chunk: string }
  | { type: "tool"; tool: AgentToolCall }
  | { type: "toolResult"; id: string; content: string; isError?: boolean }
  | { type: "usage"; usage: AgentUsage }
  /** Tool-input streaming for `ask_user` calls. Lets the editor render
   *  the question form progressively as the model writes it, instead
   *  of waiting for the elicitation request to fire after the full
   *  JSON is parsed. The Anthropic SDK emits these via stream_event /
   *  content_block_delta with `input_json_delta` deltas; the editor
   *  buffers `partialJson` keyed by `toolUseId`, lenient-parses on
   *  each delta, and mounts each completed question section as it
   *  arrives. When the matching `elicit` event finally fires it
   *  carries the same `toolUseId` so the preview promotes in place. */
  | { type: "elicitPreviewStart"; toolUseId: string; toolName: string }
  | { type: "elicitPreviewDelta"; toolUseId: string; partialJson: string }
  | { type: "elicitPreviewStop"; toolUseId: string };
