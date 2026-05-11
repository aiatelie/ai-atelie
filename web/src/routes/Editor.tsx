/* Editor.tsx — Figma-shaped multi-tab editor for sandbox projects.
 *
 * Each tab loads one of the active project's files in a same-origin
 * iframe (via /p/<id>/<route>). Modes: Comment (pin AI bubble on click),
 * Edit (click-to-select → right-side Inspector), Draw (overlay strokes),
 * default Select.
 *
 * Three coexisting edit paths converge here:
 *   1. AI chat (right sidebar) — every comment/turn writes to source via
 *      the Claude Agent SDK; element context flows through
 *      <mentioned-element> blocks built from the iframe selection.
 *   2. Tweak bridge (toolbar "Edit live" toggle) — only when the iframe
 *      page declared __edit_mode_available; knob changes route through
 *      /api/projects/:id/tweak which rewrites the EDITMODE-marked JSON.
 *   3. Inspector + "Save N edits" (toolbar split-button) — ad-hoc CSS
 *      changes captured in localStorage as a scratchpad, then written
 *      to _inspector_edits.css via /api/projects/:id/inspector-css on
 *      Save. The chevron menu exposes "Bake to source" (AI) for permanence.
 *
 * The localStorage layer is a *preview* layer; the source-of-truth is
 * always disk. After a successful Save (or Reset, or Bake), localStorage
 * is cleared so the iframe renders straight from the file's CSS.
 *
 * See web/README.md for the broader architecture.
 */

import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import s from "../components/editor/editor.module.css";
import type { SelectedInfo } from "../components/editor/Inspector";
import { CommentBubble, type CommentTarget, type Attachment } from "../components/editor/CommentBubble";
import { CommentPins } from "../components/editor/CommentPins";
import { LeftPanel } from "../components/editor/LeftPanel";
import { FileBrowserView, PageIcon, ComponentIcon, AssetIcon } from "../components/editor/FileBrowserView";
import { toast } from "../components/toast";
import { Spinner } from "../components/feedback";

// Lazy-loaded heavy components — pulled out of the initial bundle and
// fetched only when the user actually opens them. Each lazy() returns a
// chunk Vite emits at build time, dropping the editor's first-load JS by
// roughly 30-50%. Suspense fallback is null because each of these is a
// modal/overlay or only-visible-in-X-mode — there's no UI to keep
// stable while loading.
const Inspector = lazy(() => import("../components/editor/Inspector").then((m) => ({ default: m.Inspector })));
const AssetsDialog = lazy(() => import("../components/editor/AssetsDialog").then((m) => ({ default: m.AssetsDialog })));
const TemplatesDialog = lazy(() => import("../components/editor/TemplatesDialog").then((m) => ({ default: m.TemplatesDialog })));
const SettingsDialog = lazy(() => import("../components/editor/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const TweaksPreviewDialog = lazy(() => import("../components/editor/TweaksPreviewDialog").then((m) => ({ default: m.TweaksPreviewDialog })));
const QuickSwitcher = lazy(() => import("../components/editor/QuickSwitcher").then((m) => ({ default: m.QuickSwitcher })));
const KeyboardShortcutsModal = lazy(() => import("../components/editor/KeyboardShortcutsModal").then((m) => ({ default: m.KeyboardShortcutsModal })));
const DrawOverlay = lazy(() => import("../components/editor/DrawOverlay").then((m) => ({ default: m.DrawOverlay })));
const DrawActionBar = lazy(() => import("../components/editor/DrawActionBar").then((m) => ({ default: m.DrawActionBar })));
const IframeErrorOverlay = lazy(() => import("../components/editor/IframeErrorOverlay").then((m) => ({ default: m.IframeErrorOverlay })));
import { clearStrokes, useStrokes, compositeStrokesOnto } from "../lib/drawings";
import { useProjects, updateProject, setActiveProject, hydrateProjectFromServer } from "../lib/projects";
import { applySharedAssetsToDoc } from "../lib/sharedAssets";
import {
  addComment,
  bulkResolve,
  clearPromoted,
  listComments,
  markPromoted,
  releaseProject as releaseCommentsProject,
  updateComment,
  type LocalComment,
} from "../lib/comments";
import { DmBridge } from "../lib/dmBridge";
import { captureDomSnapshot, restoreDomSnapshot } from "../lib/domSnapshot";
import { captureIframeAsDataUrl, captureElementAsDataUrl, downloadDataUrl, type ExportFormat } from "../lib/screenshot";
import { useTweakBridge } from "../lib/tweakBridge";
import type { ChatMessage, ChatThread, ThreadArchive, QueuedMessage } from "../components/editor/ChatSidebar";
import { loadThreads as libLoadThreads, saveThreads, subscribeThreads, releaseProject as releaseThreadsProject } from "../lib/threads";
import { attachStreamToThread, detachStream, isThreadShadowed } from "../lib/streamPersistence";
import { cssPath, resolveCssPath, buildDescriptor } from "../lib/cssPath";
import { classifyKind, computedHints, smartLabel } from "../lib/smartLabel";
import { applyOverrides, setOverride, clearRoute, readRoute, useOverrideCount, useDirtyRoutes } from "../lib/editorOverrides";
import { notifyTurnComplete } from "../lib/notifications";
import { trackEvent } from "../lib/telemetry";
import { buildSkillsPreamble, loadActiveSkills } from "../data/skills";
import {
  startStream,
  subscribeStream,
  isStreamActive,
  getStreamState,
  abortStream,
  newStreamId,
  notifyServerStop,
  resumeStream,
  type StreamEvent,
  type ElicitRequest,
  type ToolCall,
} from "../lib/chatStream";
import { pickBusyPhrase } from "../lib/busyPhrases";

type DisplayMode = "fill" | "frame";
type Viewport = { w: number; h: number; preset?: ViewportPresetId };
type ViewportPresetId = "desktop" | "laptop" | "tablet" | "mobile" | "custom";
type Tab = {
  id: string;
  label: string;
  route: string;
  display: DisplayMode;
  viewport?: Viewport;
  /** Pinned tabs sort to the front and skip the regular close button. */
  pinned?: boolean;
};
type Mode = "select" | "comment" | "edit" | "draw" | "export";

const VIEWPORT_PRESETS: { id: ViewportPresetId; label: string; w: number; h: number }[] = [
  { id: "desktop", label: "Desktop · 1440",  w: 1440, h: 900 },
  { id: "laptop",  label: "Laptop · 1280",   w: 1280, h: 820 },
  { id: "tablet",  label: "Tablet · 768",    w: 768,  h: 1024 },
  { id: "mobile",  label: "Mobile · 375",    w: 375,  h: 812 },
];
const DEFAULT_VIEWPORT: Viewport = { w: 1280, h: 820, preset: "laptop" };

// Routes that are interactive design tools (their own viewport, fixed
// overlays) — render them full-bleed. Everything else gets the framed
// Figma-style preview at zoom.
const FILL_ROUTES = new Set(["/titling", "/editor"]);
function defaultDisplay(route: string): DisplayMode {
  return FILL_ROUTES.has(route) ? "fill" : "frame";
}

/** The "Design Files" tab is synthetic — not stored in the project's
 *  openTabs. It always sits at the start of the tab strip and renders a
 *  full file browser + preview pane in place of the iframe canvas. */
const DESIGN_FILES_TAB_ID = "__design_files__";

function uniqueTabId(): string {
  return Math.random().toString(36).slice(2, 9);
}

/** Infer a kind for the tab strip icon from a file route. Mirrors the
 *  classification FileBrowserView uses for its file rows so the tab
 *  glyph matches the design-files glyph for the same file. */
type TabKind = "page" | "component" | "asset";
const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mp3|wav|ogg|woff2?|otf|ttf)$/i;
function tabKind(route: string): TabKind {
  const path = route.replace(/^\/+/, "");
  if (ASSET_EXT_RE.test(path)) return "asset";
  if (/\.(jsx|tsx)$/i.test(path)) return "component";
  return "page";
}
function TabKindIcon({ kind }: { kind: TabKind }) {
  if (kind === "component") return <ComponentIcon />;
  if (kind === "asset") return <AssetIcon />;
  return <PageIcon />;
}

function mintSessionId(): string {
  // UUID format so Claude's --session-id accepts it. Kimi accepts any
  // string, so this works for both providers.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Older browsers — fall back to a v4-shaped string.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Re-shape per-thread messages: normalize legacy tool shapes, and flip
 *  `pending: true` assistants to `false` when the matching stream is no
 *  longer active in module state. Used in every path that lands threads
 *  in React state — the synchronous useState initializer, the project-
 *  change useEffect, AND the async subscribeThreads callback (otherwise
 *  a stuck-pending message survives a page refresh because the cache
 *  fills async, after the synchronous sanitizer has already run on
 *  empty input). */
function sanitizeThreads(threads: ChatThread[]): { threads: ChatThread[]; dirty: boolean } {
  let dirty = false;
  const next = threads.map((t) => {
    if (!t.messages) return t;
    let touched = false;
    const messages = t.messages.map((m, i, arr) => {
      if (m.role !== "assistant") return m;
      const tools = normalizeTools((m as { tools?: unknown }).tools);
      let nm: ChatMessage = tools === m.tools ? m : { ...m, tools };
      if (nm.pending) {
        const userMsg = arr[i - 1];
        const streamId = userMsg && userMsg.role === "user" ? userMsg.streamId : undefined;
        if (!isStreamActive(streamId)) {
          // If we have a streamId, give the server-side replay endpoint
          // a chance: the re-attach useEffect will probe it on mount and
          // either reattach the live run or strand the message itself
          // when 404 comes back. Stranding here would race the resume
          // probe and lose every time. No streamId → genuinely
          // unrecoverable, strand immediately so the UI doesn't sit
          // forever on a non-resumable pending message.
          if (!streamId) {
            nm = closeStrandedAssistant(nm);
          }
        }
      } else if (
        // Heal legacy data: messages that already shipped through the old
        // sanitizer got "Run interrupted…" stamped on them even when
        // tools fired and the turn actually did real work. If we see that
        // shape now, replace the lying error with an accurate tool
        // summary so the chat reflects what happened.
        nm.error &&
        /^Run interrupted/.test(nm.error) &&
        nm.tools &&
        nm.tools.length > 0
      ) {
        const files = uniqueFiles(nm.tools);
        const summary = files.length > 0
          ? `Made ${nm.tools.length} tool call${nm.tools.length === 1 ? "" : "s"}, touching: ${files.join(", ")}.`
          : `Made ${nm.tools.length} tool call${nm.tools.length === 1 ? "" : "s"}.`;
        nm = { ...nm, error: undefined, content: nm.content || summary };
      }
      if (nm !== m) touched = true;
      return nm;
    });
    if (!touched) return t;
    dirty = true;
    return { ...t, messages };
  });
  return { threads: next, dirty };
}

/** Finalise an assistant message whose live stream is gone. We used to
 *  blindly stamp every such message with "Run interrupted before any
 *  reply arrived." — that's a lie when the turn already dispatched
 *  tools (Edit/Write/etc.) and Claude actually did the work. The
 *  symptom was: chat says "interrupted", canvas shows real output. So:
 *    • tools fired → mirror the natural `done` handler: synthesise a
 *      tool-summary content, no error chip. (Accurate: the turn ran.)
 *    • content streamed but never finalised → keep content, soft note.
 *    • neither → genuinely lost — say so, but in calmer language. */
function closeStrandedAssistant(
  nm: Extract<ChatMessage, { role: "assistant" }>,
): Extract<ChatMessage, { role: "assistant" }> {
  if (nm.tools && nm.tools.length > 0) {
    const files = uniqueFiles(nm.tools);
    const summary = files.length > 0
      ? `Made ${nm.tools.length} tool call${nm.tools.length === 1 ? "" : "s"}, touching: ${files.join(", ")}.`
      : `Made ${nm.tools.length} tool call${nm.tools.length === 1 ? "" : "s"}.`;
    return { ...nm, pending: false, content: nm.content || summary };
  }
  if (nm.content) {
    return { ...nm, pending: false, error: nm.error ?? "Reply incomplete — page reloaded mid-stream." };
  }
  return { ...nm, pending: false, error: nm.error ?? "Reply lost on reload — send again to retry." };
}

/** Chat threads now live server-side at `web/projects/<id>/.meta/threads.json`.
 *  See `lib/threads.ts` — backed by an in-memory cache so this loader stays
 *  synchronous. The wrapper below re-applies the pending-message sanitizer
 *  + tools migration that's always lived next to this component, and
 *  drops orphan activeIds that don't reference any thread (a known
 *  shape disk can land in if a write got truncated). */
function loadThreads(projectId: string): ThreadArchive {
  const archive = libLoadThreads(projectId);
  const r = sanitizeThreads(archive.threads);
  const validActiveId = r.threads.some((t) => t.id === archive.activeId)
    ? archive.activeId
    : null;
  const dirty = r.dirty || validActiveId !== archive.activeId;
  return dirty ? { threads: r.threads, activeId: validActiveId } : archive;
}

/** Threads saved before the tool-chip accordion landed stored tools as a
 *  bare `string[]` (the chip label). Re-shape them into ToolCall objects
 *  so the new renderer doesn't crash. The label is the only data we have,
 *  so `name` is parsed from "ToolName · arg" and `input` is left undefined
 *  (the chip will simply not be expandable). */
function normalizeTools(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t): ToolCall => {
    if (typeof t === "string") {
      const idx = t.indexOf("·");
      const name = idx === -1 ? t.trim() : t.slice(0, idx).trim();
      return { name, label: t };
    }
    if (t && typeof t === "object" && typeof (t as { label?: unknown }).label === "string") {
      const obj = t as Partial<ToolCall>;
      return { name: obj.name ?? "", label: obj.label ?? "", input: obj.input };
    }
    return { name: "", label: String(t ?? "") };
  });
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function uniqueFiles(tools: ToolCall[]): string[] {
  const seen = new Set<string>();
  for (const t of tools) {
    // Each tool label is "ToolName" or "ToolName · filename.ext".
    const idx = t.label.indexOf("·");
    if (idx === -1) continue;
    const file = t.label.slice(idx + 1).trim();
    if (file) seen.add(file);
  }
  return Array.from(seen);
}

function routeToLabel(route: string): string {
  if (route === "/") return "index.html";
  if (route === "/titling") return "titling.html";
  const m = route.match(/^\/ep\/([^/]+)\/([^/]+)$/);
  if (m) return `slot.html?ep=${m[1]}&slot=${m[2]}`;
  return route;
}

/* Brand mark — small palette icon that sits before the project title.
 * Decorative; anchors the left edge of the tab bar. Click handler is
 * the parent ProjectTitle so it doesn't add a new affordance. */
function BrandMark() {
  return (
    <span className={s.brandMark} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2 L20 6 V18 L12 22 L4 18 V6 Z" />
      </svg>
    </span>
  );
}

/* Click-to-rename project title (data-testid mirrors Omelette's). */
function ProjectTitle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  if (editing) {
    return (
      <span className={s.projectTitleWrap}>
        <BrandMark />
        <input
          autoFocus
          className={s.projectTitleInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onChange(draft.trim() || value); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onChange(draft.trim() || value); setEditing(false); }
            else if (e.key === "Escape") { setDraft(value); setEditing(false); }
          }}
        />
      </span>
    );
  }
  return (
    <span className={s.projectTitleWrap}>
      <BrandMark />
      <span
        className={s.projectTitle}
        data-testid="project-title"
        title={value}
        onClick={() => setEditing(true)}
      >
        {value}
      </span>
    </span>
  );
}

export default function Editor() {
  const [params, setParams] = useSearchParams();
  const { active: activeProject } = useProjects();

  // No active project (first run, or last project deleted) → bounce to
  // the Projects dashboard so the user can pick or create one. The
  // redirect short-circuits the rest of this component, so every use of
  // `activeProject` below can safely assume it's non-null.
  if (!activeProject) {
    return <Navigate to="/projects" replace />;
  }

  // Tabs flow through the active project's openTabs. setTabs writes back
  // to the project so reloads + project-switches stay in sync.
  const tabs: Tab[] = activeProject.openTabs as Tab[];
  const setTabs = useCallback((updater: Tab[] | ((prev: Tab[]) => Tab[])) => {
    updateProject(activeProject.id, (p) => ({
      openTabs: typeof updater === "function" ? (updater as (prev: Tab[]) => Tab[])(p.openTabs as Tab[]) : updater,
    }));
  }, [activeProject.id]);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads(activeProject.id).threads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => loadThreads(activeProject.id).activeId);
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? threads[0] ?? null;

  // True for the single render right after a project switch — the load
  // useEffect's `setThreads` hasn't applied yet, so the save useEffect
  // would otherwise persist the PREVIOUS project's threads into the
  // newly-active project's meta file. The save effect reads + clears
  // this flag once and skips that one cross-project write.
  const projectJustSwitchedRef = useRef(false);

  // Re-load threads when the active project changes — chat is per-project.
  useEffect(() => {
    projectJustSwitchedRef.current = true;
    const archive = loadThreads(activeProject.id);
    setThreads(archive.threads);
    setActiveThreadId(archive.activeId);
    setAutoResolvePromptIds([]);
    trackEvent("project_open", { in_editor: "true" }, activeProject.id);
    // When the user switches AWAY from this project, drop its meta-event
    // SSE subscriptions so we don't accumulate one open socket per
    // project ever visited. Browser caps HTTP/1.1 at 6 sockets per
    // origin — without this the app starts feeling "dead" after a few
    // project switches because new fetches queue forever behind dead-
    // but-open SSEs. The lib caches stay warm; the next visit to this
    // project re-subscribes lazily.
    const releaseId = activeProject.id;
    return () => {
      releaseThreadsProject(releaseId);
      releaseCommentsProject(releaseId);
    };
  }, [activeProject.id]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  // When a comment is selected from the LeftPanel Comments list, scroll
  // the iframe to its element so the user lands where they left it. The
  // tab-switch already happens in selectPinAndJump; this effect is the
  // second half — find the element and scrollIntoView. Retries once if
  // the iframe is still loading after a tab switch.
  useEffect(() => {
    if (!selectedPinId) return;
    const c = listComments(activeProject.id).find((x) => x.id === selectedPinId);
    if (!c) return;
    const selector = c.selector;
    if (!selector) return;
    const tryScroll = () => {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return false;
      const el = doc.querySelector(selector) as HTMLElement | null;
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    };
    if (tryScroll()) return;
    const t = setTimeout(tryScroll, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPinId, activeProject.id]);
  // Currently-pending MCP elicitation (Claude called ask_user). Set by
  // buildStreamHandler when an `elicit` SSE event arrives; cleared once
  // the user submits the form (POSTs /api/elicit-response) or the stream
  // ends without resolution. We track the originating threadId so the
  // sidebar can auto-switch to that thread — otherwise the form floats
  // above an "empty" body when the user is on a different thread.
  const [pendingElicit, setPendingElicit] = useState<{ request: ElicitRequest; threadId: string } | null>(null);
  // One-slot composer queue. When the user types into a disabled
  // composer (assistant still streaming or an elicit form is open) and
  // hits Enter, the message lands here instead of dropping. A useEffect
  // below drains it once the turn ends. Scoped per thread so switching
  // threads mid-queue doesn't fire the queued message into a different
  // session.
  const [queued, setQueued] = useState<(QueuedMessage & { threadId: string; target: CommentTarget | null; includeCanvas?: boolean; preamble?: string }) | null>(null);
  // Comments awaiting the post-stream "Resolve N promoted comments?"
  // confirmation strip (rendered above the comments list). Cleared on
  // confirm or dismiss. Scoped to one project — switching projects clears
  // it implicitly via the parent re-render.
  const [autoResolvePromptIds, setAutoResolvePromptIds] = useState<string[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which section of SettingsDialog to land on. Defaults to the Theme
  // tab on plain "open settings" clicks; the ActiveSkillsStrip flips it
  // to "skills" when the user clicks the strip to edit their selection.
  const [settingsSection, setSettingsSection] = useState<"theme" | "skills" | "notifications" | "adapters" | "about">("theme");
  const openSkillsSettings = useCallback(() => {
    setSettingsSection("skills");
    setSettingsOpen(true);
  }, []);
  const [tweaksPreviewPrompt, setTweaksPreviewPrompt] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const dmRef = useRef<DmBridge | null>(null);
  // Host-side data-dm-ref counter. Used in the applyToSelection fallback
  // when the inject-script hasn't lazily stamped the target yet — we set
  // a stable attribute so domSnapshot can capture pre-mutation state.
  // Starts above 1e9 so it never collides with the inject-script's own
  // counter (which starts at 1 and bumps on demand).
  const hostStampCounter = useRef<number>(1_000_000_000);

  // Wire a fresh DM bridge each time the iframe identity changes.
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    const dm = new DmBridge(ifr);
    dmRef.current = dm;
    return () => { dm.dispose(); if (dmRef.current === dm) dmRef.current = null; };
  });

  // Live-propagate shared asset changes into the iframe (re-write CSS
  // variables on document.documentElement). Same-origin iframe so direct
  // DOM mutation is fine; no postMessage needed.
  useEffect(() => {
    const refresh = () => {
      const doc = iframeRef.current?.contentDocument;
      if (doc) applySharedAssetsToDoc(doc);
    };
    refresh();
    window.addEventListener("shared-assets:change", refresh);
    return () => window.removeEventListener("shared-assets:change", refresh);
  });

  // Persist thread archive on every change so a refresh keeps conversations.
  //
  // streamPersistence.ts owns the persistence path for any thread that has
  // a live (or recently-finished) stream attached — the shadow listener
  // mutates the cached archive directly, regardless of which project the
  // user is currently viewing. This effect skips writes for shadow-tracked
  // threads to avoid a dual-write race that could clobber tool/text
  // appended by the shadow but not yet reflected in React state. Manual
  // edits (rename, delete, edit user message) still flow through here.
  useEffect(() => {
    // First commit after a project switch: `threads` here is the
    // PREVIOUS project's data — React hasn't applied the load useEffect's
    // setThreads yet. Skip this one save to avoid writing A's threads
    // into B's meta file. The very next render (with the new threads
    // applied) will fire this effect again and save correctly.
    if (projectJustSwitchedRef.current) {
      projectJustSwitchedRef.current = false;
      return;
    }
    try {
      const archive: ThreadArchive = { threads, activeId: activeThreadId };
      // Cap DOM snapshots: only the LAST 10 user messages keep their
      // domHtml; older ones drop it (keep their thumbnail though, which
      // is small). Restore stays available for recent turns; old turns
      // become read-only history. This keeps localStorage in budget.
      const SNAP_RECENT = 10;
      const trimmed = threads.map((thread) => {
        // Shadow-tracked threads: the in-memory cached archive is the
        // source of truth right now; merging React state could erase
        // streamed deltas the shadow has already persisted. Reuse the
        // cached version of this thread instead.
        if (isThreadShadowed(activeProject.id, thread.id)) {
          const cached = libLoadThreads(activeProject.id).threads.find((t) => t.id === thread.id);
          if (cached) return cached;
        }
        let userMsgsRemaining = thread.messages.filter((m) => m.role === "user").length;
        return {
          ...thread,
          messages: thread.messages.map((m) => {
            if (m.role !== "user") return m;
            const keepThis = userMsgsRemaining <= SNAP_RECENT;
            userMsgsRemaining--;
            if (keepThis) return m;
            if (!m.domHtml) return m;
            return { ...m, domHtml: undefined };
          }),
        };
      });
      saveThreads(activeProject.id, { ...archive, threads: trimmed });
    } catch { /* ignore */ }
  }, [threads, activeThreadId, activeProject.id]);

  // Cross-tab/browser sync: refresh state when another tab edits the
  // same project's threads via the SSE invalidation pipe. Run the same
  // sanitizer used by the synchronous loader so the async cache-fill
  // path on first mount also unsticks any pending:true messages whose
  // streams aren't actually live (page reloaded mid-turn). Also drop
  // orphan activeIds that don't reference any thread.
  useEffect(() => {
    return subscribeThreads(activeProject.id, (next) => {
      const { threads: cleaned } = sanitizeThreads(next.threads);
      const validActiveId = cleaned.some((t) => t.id === next.activeId)
        ? next.activeId
        : null;
      setThreads(cleaned);
      setActiveThreadId(validActiveId);
    });
  }, [activeProject.id]);

  function generateThreadTitle(text: string): string {
    const clean = text.trim().replace(/\s+/g, " ");
    if (clean.length <= 30) return clean;
    return clean.slice(0, 27) + "…";
  }

  const startNewThread = (title?: string): ChatThread => {
    const t: ChatThread = {
      id: mintSessionId(),
      title: title ?? `Thread · ${formatTime(Date.now())}`,
      messages: [],
      createdAt: Date.now(),
    };
    setThreads((prev) => [t, ...prev]);
    setActiveThreadId(t.id);
    return t;
  };

  const renameThread = (threadId: string, title: string) => {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title: title.trim() || t.title } : t)));
  };

  /** Surface a toolbar-initiated export as an inline ArtifactCard in the
   *  active thread (creating one if none exists). The chat already
   *  renders artifact-shaped tool results via parseArtifact + the
   *  existing assistant-message tool list — we synthesize a minimal
   *  assistant turn whose single tool result is the artifact JSON, so
   *  the card renders without any new chat-side wiring.
   *
   *  Replaces the old auto-download flow (downloadDataUrl). The user's
   *  download is now opt-in via the card's "Download" button. */
  const pushArtifactToChat = (artifact: { url: string; filename: string; bytes: number; mime: string; kind: string; metadata?: Record<string, unknown> }, summary: string) => {
    let threadId = activeThread?.id;
    if (!threadId) {
      threadId = startNewThread().id;
    }
    const message: ChatMessage = {
      role: "assistant",
      content: summary,
      tools: [{
        name: "toolbar_export",
        label: `Saved · ${artifact.filename}`,
        input: { kind: artifact.kind, format: artifact.mime },
        result: JSON.stringify(artifact),
      }],
      ts: Date.now(),
    };
    setThreads((prev) => prev.map((t) => (t.id === threadId
      ? { ...t, messages: [...t.messages, message] }
      : t)));
    // Bump the chat tab so the user sees the artifact even if they
    // were on Files / Layers / Comments when they hit Capture.
    setChatTabSwitchKey((k) => k + 1);
  };

  const deleteMessagesFrom = (threadId: string, index: number) => {
    setThreads((prev) => prev.map((t) => {
      if (t.id !== threadId) return t;
      // Abort any in-flight streams owned by messages we're deleting.
      // Otherwise the SDK keeps generating tokens to a UI that will never
      // show them, wasting subscription quota. Also detach the
      // persistence shadow so it can't write a stale msgIdx into the
      // (newly truncated) thread.
      for (let i = index; i < t.messages.length; i++) {
        const m = t.messages[i];
        if (m.role === "user" && m.streamId) {
          // Truncating the thread destroys the assistant message that
          // would have rendered any reattach output — bypass the
          // server-side grace window so the SDK aborts immediately.
          void notifyServerStop(m.streamId);
          abortStream(m.streamId);
          detachStream(m.streamId);
        }
      }
      return { ...t, messages: t.messages.slice(0, index) };
    }));
    // If the pending elicit belongs to this thread, drop it — the
    // assistant message that would have read its answer is being deleted.
    setPendingElicit((p) => (p && p.threadId === threadId ? null : p));
  };

  const retryTurn = async (threadId: string, userIndex: number) => {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    const userMsg = thread.messages[userIndex];
    if (!userMsg || userMsg.role !== "user") return;

    // Remove the old assistant message (if any) right after this user message
    setThreads((prev) => prev.map((t) => {
      if (t.id !== threadId) return t;
      const next = t.messages.slice(0, userIndex + 1);
      next.push({
        role: "assistant",
        content: "",
        tools: [],
        ts: Date.now(),
        pending: true,
      });
      return { ...t, messages: next };
    }));

    const aIdx = userIndex + 1;
    const handler = buildStreamHandler(threadId, aIdx);
    // Mirror the new pending assistant message into the cached archive
    // so the shadow listener finds the right msgIdx target before any
    // SSE event arrives. (See identical block in runTurn.)
    {
      const cached = libLoadThreads(activeProject.id);
      const cIdx = cached.threads.findIndex((t) => t.id === threadId);
      if (cIdx !== -1) {
        const cachedThread = cached.threads[cIdx];
        const trimmed = cachedThread.messages.slice(0, userIndex + 1);
        trimmed.push({
          role: "assistant",
          content: "",
          tools: [],
          ts: Date.now(),
          pending: true,
        });
        const nextThreads = cached.threads.slice();
        nextThreads[cIdx] = { ...cachedThread, messages: trimmed };
        saveThreads(activeProject.id, { ...cached, threads: nextThreads });
      }
    }
    // Same screenshot guarantee as runTurn — capture fresh on every retry
    // so Claude sees the current iframe state, not the original send.
    let screenshotDataUrl: string | undefined;
    if (iframeRef.current) {
      try {
        screenshotDataUrl = await captureIframeAsDataUrl(iframeRef.current, {
          scale: userMsg.selector ? 1 : 0.5,
          selector: userMsg.selector,
        });
      } catch { /* best-effort */ }
    }
    const scopeFile = activeTab.route.startsWith("_preview/")
      ? activeTab.route.slice("_preview/".length)
      : undefined;
    const retryStreamId = userMsg.streamId ?? newStreamId();
    const shadowHandler = attachStreamToThread({
      projectId: activeProject.id,
      threadId,
      streamId: retryStreamId,
      msgIdx: aIdx,
    });
    // Apply the *current* chip posture to the retry. We don't persist
    // the original-send preamble per message (the bubble only stores
    // the typed text), so on retry we rebuild from the live chip state.
    // Semantically right: chips are sticky posture for the project, so
    // "retry this turn with my current chips on" matches what the user
    // expects when they toggle a chip and hit retry. The opposite —
    // replaying the exact original send byte-for-byte — would silently
    // ignore the chip the user just turned on.
    const retryPreamble = buildSkillsPreamble(loadActiveSkills(activeProject.id));
    const retryComment = retryPreamble
      ? `${retryPreamble}\n\n${userMsg.content}`
      : userMsg.content;
    await startStream({
      streamId: retryStreamId,
      body: {
        route: activeTab.route,
        selector: userMsg.selector ?? "",
        tag: userMsg.tag ?? "",
        innerText: userMsg.innerText,
        comment: retryComment,
        attachments: [],
        screenshotDataUrl,
        sessionId: thread.id,
        modelId: userMsg.modelId,
        projectId: activeProject.id,
        scopeFile,
      },
      listeners: [handler, shadowHandler],
    });
  };

  // Build a stable mutator for an assistant message at index `aIdx`
  // inside the active thread. Used both by runTurn and the re-attach effect.
  const makeAssistantUpdater = (threadId: string, aIdx: number) =>
    (mut: (m: Extract<ChatMessage, { role: "assistant" }>) => Extract<ChatMessage, { role: "assistant" }>) => {
      setThreads((prev) => prev.map((t) => {
        if (t.id !== threadId) return t;
        const next = [...t.messages];
        const m = next[aIdx];
        if (!m || m.role !== "assistant") return t;
        next[aIdx] = mut(m);
        return { ...t, messages: next };
      }));
    };

  // Wire one chatStream into a thread's assistant message. Returns the
  // event handler that translates StreamEvent → setThreads mutations.
  const buildStreamHandler = (threadId: string, aIdx: number) => {
    const updateAssistant = makeAssistantUpdater(threadId, aIdx);
    let textBuf = "";
    let thinkBuf = "";
    let flushScheduled = false;
    const FLUSH_MS = 33;
    const flush = () => {
      flushScheduled = false;
      if (!textBuf && !thinkBuf) return;
      const t = textBuf; textBuf = "";
      const k = thinkBuf; thinkBuf = "";
      updateAssistant((m) => ({
        ...m,
        content: t ? m.content + t : m.content,
        thinking: k ? (m.thinking ?? "") + k : m.thinking,
      }));
    };
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      setTimeout(flush, FLUSH_MS);
    };
    const flushText = flush; // back-compat for the call sites below

    return (e: StreamEvent) => {
      if (e.type === "text") { textBuf += e.chunk; scheduleFlush(); return; }
      if (e.type === "finalText") {
        // Adopt the SDK's final-result text only when nothing arrived as
        // deltas this turn. Mirrors the dedup rule in chatStream.ts.
        flushText();
        updateAssistant((m) => (m.content ? m : { ...m, content: e.chunk }));
        return;
      }
      if (e.type === "thinking") { thinkBuf += e.chunk; scheduleFlush(); return; }
      if (e.type === "tool") { updateAssistant((m) => ({ ...m, tools: [...m.tools, e.tool] })); return; }
      if (e.type === "toolResult") {
        updateAssistant((m) => ({
          ...m,
          tools: m.tools.map((t) =>
            t.id === e.id ? { ...t, result: e.content, isError: e.isError } : t,
          ),
        }));
        return;
      }
      if (e.type === "turnId") { updateAssistant((m) => ({ ...m, turnId: e.turnId })); return; }
      if (e.type === "elicit") {
        setPendingElicit({ request: e.request, threadId });
        // Force-switch the active thread to whichever one the model is
        // currently asking from. Stale switching shouldn't strand a form
        // on a thread the user can't see.
        setActiveThreadId(threadId);
        return;
      }
      if (e.type === "elicitClear") { setPendingElicit((p) => (p && p.request.id === e.id ? null : p)); return; }
      if (e.type === "error") {
        flushText();
        setPendingElicit(null);
        updateAssistant((m) => ({ ...m, error: e.message, pending: false }));
        notifyTurnComplete({
          status: "failure",
          title: `${projectTitle} · agent error`,
          body: e.message.slice(0, 140),
          tag: `aiatelie-${activeProject.id}`,
        });
        return;
      }
      if (e.type === "done") {
        flushText();
        setPendingElicit(null);
        updateAssistant((m) => {
          if (!m.content && !m.error && m.tools.length > 0) {
            const files = uniqueFiles(m.tools);
            const summary = files.length > 0
              ? `Made ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}, touching: ${files.join(", ")}.`
              : `Made ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}.`;
            return { ...m, content: summary, pending: false };
          }
          if (!m.content && !m.error) {
            return { ...m, error: "No reply received from AI (process exited without output).", pending: false };
          }
          return { ...m, pending: false };
        });
        notifyTurnComplete({
          status: "success",
          title: `${projectTitle} · agent done`,
          body: "Your turn finished — click to bring this tab forward.",
          tag: `aiatelie-${activeProject.id}`,
        });
      }
    };
  };

  // Re-attach to any chatStream after Editor (re)mounts. The sanitizer in
  // loadThreads leaves `pending: true` when it detects a live stream; this
  // effect finds those, hydrates from the module's accumulated state, and
  // subscribes for further events.
  //
  // Note: we subscribe even for already-`done` streams. subscribeStream will
  // immediately replay the terminal event(s) to the late listener, which
  // lets buildStreamHandler clear `pending` for messages whose stream
  // finished while the editor was unmounted. Without that path, a finished
  // stream would never deliver `done` to the new instance and the message
  // would be stuck "thinking" until the next mount + sanitizer pass.
  useEffect(() => {
    if (!activeThread) return;
    const last = activeThread.messages[activeThread.messages.length - 1];
    if (!last || last.role !== "assistant" || !last.pending) return;
    const userMsg = activeThread.messages[activeThread.messages.length - 2];
    const streamId = userMsg && userMsg.role === "user" ? userMsg.streamId : undefined;
    if (!streamId) return;
    const aIdx = activeThread.messages.length - 1;
    const updateAssistant = makeAssistantUpdater(activeThread.id, aIdx);

    // 1. In-tab path — chatStream module survived (e.g. HMR remount of
    //    Editor.tsx but the SSE pump kept running). Hydrate + subscribe.
    const cur = getStreamState(streamId);
    if (cur) {
      updateAssistant((m) => ({
        ...m,
        content: cur.text || m.content,
        thinking: cur.thinking || m.thinking,
        tools: cur.tools.length > 0 ? cur.tools : m.tools,
        turnId: cur.turnId ?? m.turnId,
        error: cur.error ?? m.error,
      }));
      if (cur.elicit) setPendingElicit({ request: cur.elicit, threadId: activeThread.id });
      const handler = buildStreamHandler(activeThread.id, aIdx);
      return subscribeStream(streamId, handler);
    }

    // 2. Server-resume path — full reload happened, the in-tab module
    //    state is gone. Try the server's replay endpoint: if it has a
    //    buffered run for this streamId, we reattach without re-issuing
    //    the AI turn (no double-bill). Falls through to (3) on 404.
    //
    //    Race guard: a fresh `runTurn` registers the streamId in
    //    chatStream synchronously (`streams.set` in startStream), but
    //    runTurn awaits a screenshot capture before calling startStream.
    //    During that await, React re-renders and this effect can run
    //    too early — `getStreamState` returns null and we'd race-probe
    //    a streamId the server hasn't registered yet. A short delay
    //    + re-check on cur lets the in-tab path take over for fresh
    //    sends; reload-resume scenarios still hit the probe (in-tab
    //    state stays null no matter how long we wait, because the
    //    module was just initialized empty).
    let cancelled = false;
    let attached: (() => void) | null = null;
    void (async () => {
      // Yield ~250ms — captures the typical `captureIframeAsDataUrl`
      // window in runTurn before its `startStream` call lands.
      await new Promise((r) => setTimeout(r, 250));
      if (cancelled) return;
      const recheck = getStreamState(streamId);
      if (recheck) {
        // Fresh-send raced ahead of us; the in-tab path would have
        // attached above on a later effect run. Subscribe here so
        // events from the now-registered stream drive React state.
        const handlerLate = buildStreamHandler(activeThread.id, aIdx);
        attached = subscribeStream(streamId, handlerLate);
        return;
      }
      const projectId = activeProject.id;
      const threadId = activeThread.id;
      const handler = buildStreamHandler(threadId, aIdx);
      const shadowHandler = attachStreamToThread({
        projectId,
        threadId,
        streamId,
        msgIdx: aIdx,
        resumeFrom: "snapshot",
      });
      const ok = await resumeStream(streamId, [handler, shadowHandler]);
      if (cancelled) {
        detachStream(streamId);
        return;
      }
      if (!ok) {
        // 3. Genuinely stranded — server has no buffered run for this
        //    streamId (server restarted, GC'd, or never tracked it).
        //    Apply closeStrandedAssistant ourselves; the sanitizer
        //    deferred this so the resume probe could try first.
        detachStream(streamId);
        updateAssistant((m) => closeStrandedAssistant(m));
        return;
      }
      // Subscribe via the chatStream surface so further events drive
      // the React handler. resumeStream registered the stream with the
      // shadow handler in the `listeners` set already; subscribeStream
      // here is what gives us the unsubscribe hook for cleanup.
      attached = subscribeStream(streamId, () => { /* handler is already attached */ });
    })();

    return () => {
      cancelled = true;
      if (attached) attached();
    };
    // Only re-evaluate when the active thread identity / pending shape changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id, activeThread?.messages.length]);

  // Run one comment-edit turn: append user + pending-assistant messages,
  // stream the SSE response, mutate the assistant message in place.
  // Used by both the Comment bubble and the sidebar Composer.
  const runTurn = async (opts: {
    text: string;
    attachments: Attachment[];
    target?: CommentTarget | null;
    startNewThread?: boolean;
    modelId?: string;
    /** When false, skip the iframe screenshot + DOM snapshot for this
     *  turn. Defaults to true (legacy behaviour). The composer's "Current
     *  view" chip × toggles this off for one send. */
    includeCanvas?: boolean;
    /** Pre-built PNG dataUrl to use as the diagnostic page screenshot
     *  in place of the auto-captured one. Used by Draw mode so the AI
     *  sees the user's strokes flattened onto the current view. */
    screenshotOverride?: string;
    /** Pre-built PNG dataUrl to use as the user-bubble thumbnail in
     *  place of the DOM-snapshot's auto-captured one. Draw mode passes
     *  the composite so the bubble shows what the user actually sent
     *  (page + strokes), not a fresh unmarked re-capture. */
    thumbnailOverride?: string;
    /** Hidden text prepended to `text` in the API request, but never
     *  shown in the user bubble. Used to ride the project intake brief
     *  along with the user's first send (Image-57-style welcome flow). */
    preamble?: string;
  }) => {
    const includeCanvas = opts.includeCanvas !== false;
    let thread = activeThread;
    if (opts.startNewThread || !thread) thread = startNewThread();
    const threadId = thread.id;

    // For follow-ups without a new element click, fall back to the most
    // recently referenced element so the AI keeps anchored on the same target.
    const lastUser = [...thread.messages].reverse().find((m) => m.role === "user") as
      | Extract<ChatMessage, { role: "user" }>
      | undefined;
    const target = opts.target ?? (lastUser
      ? {
          x: 0, y: 0, localX: 0, localY: 0,
          selector: lastUser.selector ?? "",
          tag: lastUser.tag ?? "",
          innerText: undefined,
          outerHtml: undefined,
          descriptor: lastUser.descriptor,
          kind: lastUser.kind,
        } as CommentTarget
      : null);

    const streamId = newStreamId();
    const userMsg: ChatMessage = {
      role: "user",
      content: opts.text,
      route: activeTab.route,
      selector: target?.selector,
      tag: target?.tag,
      innerText: target?.innerText,
      descriptor: target?.descriptor,
      kind: target?.kind,
      attachments: opts.attachments.length > 0 ? opts.attachments : undefined,
      preamble: opts.preamble,
      // Pre-populate the thumbnail when the caller has one ready (Draw
      // mode passes its composite). The DOM-snapshot resolver below
      // preserves this via `thumbnailOverride ?? snap.thumbnail`.
      thumbnail: opts.thumbnailOverride,
      streamId,
      modelId: opts.modelId,
      ts: Date.now(),
    };
    // Fire-and-forget DOM snapshot of the iframe — attaches to the user
    // message when ready so the bubble can show a thumbnail + offer "↺ Restore".
    // Skipped when the user toggled "Current view" off for this turn.
    const userIdx = thread.messages.length;
    if (includeCanvas) captureDomSnapshot(iframeRef.current, target?.selector).then((snap) => {
      if (!snap) return;
      setThreads((prev) => prev.map((t) => {
        if (t.id !== threadId) return t;
        const next = [...t.messages];
        const m = next[userIdx];
        if (!m || m.role !== "user") return t;
        next[userIdx] = {
          ...m,
          // thumbnailOverride wins so Draw mode's composite (page + strokes)
          // is what the user sees in the bubble, not a fresh unmarked recap.
          thumbnail: opts.thumbnailOverride ?? snap.thumbnail,
          domHtml: snap.html,
          styles: snap.styles,
          scrollX: snap.scrollX,
          scrollY: snap.scrollY,
        };
        return { ...t, messages: next };
      }));
    });
    // Auto-rename empty threads from the first user message.
    if (thread.messages.length === 0) {
      setThreads((prev) => prev.map((t) =>
        t.id === threadId ? { ...t, title: generateThreadTitle(opts.text) } : t
      ));
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      tools: [],
      ts: Date.now(),
      pending: true,
    };
    const aIdx = thread.messages.length + 1;
    setThreads((prev) => prev.map((t) =>
      t.id === threadId
        ? { ...t, messages: [...t.messages, userMsg, assistantMsg] }
        : t
    ));
    // Mirror the new messages into the cached archive synchronously so
    // streamPersistence's shadow listener has the right msgIdx target
    // even if the user switches projects before any SSE event arrives.
    // Without this, the shadow's first mutateAssistant call would find a
    // shorter archive than what React just appended. Also mirror the
    // empty-thread auto-rename so a project-switch mid-first-turn shows
    // the right tab title from the cached archive.
    {
      const cached = libLoadThreads(activeProject.id);
      const idx = cached.threads.findIndex((t) => t.id === threadId);
      if (idx !== -1) {
        const cachedThread = cached.threads[idx];
        const renamedTitle = cachedThread.messages.length === 0
          ? generateThreadTitle(opts.text)
          : cachedThread.title;
        const nextThreads = cached.threads.slice();
        nextThreads[idx] = {
          ...cachedThread,
          title: renamedTitle,
          messages: [...cachedThread.messages, userMsg, assistantMsg],
        };
        saveThreads(activeProject.id, { ...cached, threads: nextThreads });
      } else {
        // Brand-new thread (startNewThread fired this turn but the
        // project-switch save useEffect hasn't yet flushed). Inject it
        // into the cache directly so the shadow has a target.
        const newThread: ChatThread = {
          id: threadId,
          title: generateThreadTitle(opts.text),
          messages: [userMsg, assistantMsg],
          createdAt: Date.now(),
        };
        saveThreads(activeProject.id, {
          threads: [newThread, ...cached.threads],
          activeId: cached.activeId ?? threadId,
        });
      }
    }
    trackEvent("chat_send", {
      route: activeTab.route,
      hasTarget: target ? "1" : "0",
      attachments: String(opts.attachments.length),
    }, activeProject.id);

    // Attach the persistence shadow BEFORE startStream so its listener
    // can be passed in via the `listeners` array — that puts it in the
    // dispatch set before the fetch begins, so no events are missed.
    // The shadow mutates the cached archive (and thus saveThreads's
    // server PATCH) regardless of which project the user is currently
    // viewing — so a project-switch mid-stream still durably persists
    // progress for the away-from-A side.
    const shadowHandler = attachStreamToThread({
      projectId: activeProject.id,
      threadId,
      streamId,
      msgIdx: aIdx,
    });

    const handler = buildStreamHandler(threadId, aIdx);
    // Component canvas mode: when the active tab points at a synthetic
    // /_preview/<file> URL, scope the AI to ONLY that file. Strip the
    // "_preview/" prefix to get the real component path.
    const scopeFile = activeTab.route.startsWith("_preview/")
      ? activeTab.route.slice("_preview/".length)
      : undefined;

    // Attach a fresh iframe screenshot so Claude can see what the user is
    // looking at — regardless of whether they clicked a specific element.
    // The user can opt out per-turn via the composer's "Current view" chip
    // (e.g. follow-up that doesn't need a re-screenshot of the same view).
    let screenshotDataUrl: string | undefined;
    if (opts.screenshotOverride) {
      // Caller pre-built the page view (e.g. Draw mode flattened strokes
      // onto the iframe screenshot). Use it as-is.
      screenshotDataUrl = opts.screenshotOverride;
    } else if (includeCanvas && iframeRef.current) {
      try {
        screenshotDataUrl = await captureIframeAsDataUrl(iframeRef.current, {
          scale: target?.selector ? 1 : 0.5,
          selector: target?.selector,
        });
      } catch { /* best-effort — Claude still has route + selector + outerHtml */ }
    }

    await startStream({
      streamId,
      body: {
        route: activeTab.route,
        selector: target?.selector ?? "",
        tag: target?.tag ?? "",
        innerText: target?.innerText,
        outerHtml: target?.outerHtml,
        descriptor: target?.descriptor,
        comment: opts.preamble ? `${opts.preamble}\n\n${opts.text}` : opts.text,
        attachments: opts.attachments,
        screenshotDataUrl,
        sessionId: thread.id,
        modelId: opts.modelId,
        projectId: activeProject.id,
        scopeFile,
        // Send our streamId so the server uses it as the registry key
        // and a reloaded tab can resume via /api/comment-edit/replay/<streamId>.
        streamId,
      },
      listeners: [handler, shadowHandler],
    });
  };

  // ─── Composer queue (one-slot) ────────────────────────────────
  //
  // The composer's `disabled` flag is true while the active turn is
  // streaming or an elicit form is open. Pre-queue, hitting Enter in
  // that window was a silent no-op (confusing) AND there were micro-
  // windows between assistant chunks where it could squeak through —
  // starting a CONCURRENT SDK turn on the same sessionId, corrupting
  // the session log. The queue replaces both behaviours: the message
  // is held in `queued`, shown above the composer, and auto-fired when
  // the turn drains. Only one slot — re-queueing replaces the prior.
  //
  // `isAssistantPending` matches the thread-level helper used by the
  // sidebar (last assistant message has `pending: true`); we check
  // here so the wrap is the source of truth, not the child component.
  const lastIsPending = !!activeThread && (() => {
    const last = activeThread.messages[activeThread.messages.length - 1];
    return !!(last && last.role === "assistant" && last.pending);
  })();
  const isBlocked = lastIsPending || !!pendingElicit;

  // Rotating canvas-busy label. Pick a fresh phrase when a run starts,
  // swap to a new one every ~5s while it's still going. Keeps the pill
  // playful on long turns instead of staring at the same line.
  const [busyPhrase, setBusyPhrase] = useState<string>("");
  useEffect(() => {
    if (!lastIsPending) { setBusyPhrase(""); return; }
    setBusyPhrase(pickBusyPhrase());
    const t = setInterval(() => setBusyPhrase(pickBusyPhrase()), 5000);
    return () => clearInterval(t);
  }, [lastIsPending]);

  const queueOrSend = (
    text: string,
    attachments: Attachment[],
    modelId: string,
    sendOpts?: { includeCanvas?: boolean; skillsPreamble?: string },
  ) => {
    // Snapshot the same target the live `onSend` would have used, so
    // the queued message lands on the element the user was looking at
    // when they typed it — not whatever element happens to be selected
    // when the queue drains.
    const target: CommentTarget | null = selected
      ? ({
          x: 0,
          y: 0,
          localX: 0,
          localY: 0,
          selector: selected.selector,
          tag: selected.tag,
          innerText: undefined,
          outerHtml: undefined,
        } as CommentTarget)
      : null;
    // Consume the per-project intake flag on the user's first send.
    // Their typed text shows in the bubble; the intake brief rides as
    // a hidden preamble so Claude reads brief + text. Subsequent sends
    // don't re-attach it (flag is cleared after the first read).
    let preamble: string | undefined;
    if (pendingIntakeFor === activeProject.id) {
      preamble = buildIntakePreamble();
      setPendingIntakeFor(null);
    }
    // Composer skill chips ride as a hidden preamble too. When both an
    // intake brief AND skill posture exist on the same turn (the
    // user toggled a chip before sending their first message), stack
    // them so Claude reads intake → skills → user text. Both are
    // designer-context, both belong to the model not the bubble, so
    // joining with a blank line keeps them readable.
    if (sendOpts?.skillsPreamble) {
      preamble = preamble
        ? `${preamble}\n\n${sendOpts.skillsPreamble}`
        : sendOpts.skillsPreamble;
    }
    if (isBlocked && activeThread) {
      // Replace any prior queued entry — only one slot. Tie the entry
      // to the active thread so a thread switch can clear it (see the
      // separate effect below).
      setQueued({
        text,
        attachments,
        modelId,
        // eslint-disable-next-line react-hooks/purity
        queuedAt: Date.now(),
        threadId: activeThread.id,
        target,
        includeCanvas: sendOpts?.includeCanvas,
        preamble,
      });
      return;
    }
    runTurn({ text, attachments, target, modelId, includeCanvas: sendOpts?.includeCanvas, preamble });
  };

  // ─── Multi-select comment promotion ──────────────────────────
  //
  // Bundle N comments into ONE chat turn:
  //   - Build a "I have N notes on /<file>" prompt with per-comment
  //     numbered entries (selector + innerText snippet + body).
  //   - Attach one screenshot per comment (saved thumbnail, falling
  //     back to a freshly-captured route shot when the comment didn't
  //     get one — file-level free-form composer notes might not).
  //   - Anchor the turn to the first comment's element when possible
  //     so Claude has a primary CommentTarget to reason against.
  //   - Route the dispatch through queueOrSend so promotion respects
  //     the in-flight lock and the one-slot queue.
  //
  // Lifecycle: mark all promoted up-front (so the rows reflect the
  // pending state immediately), then await the stream. On error, clear
  // promoted so the rows re-appear under "Open"; on success, upgrade
  // the placeholder turnId to the real one and trigger the auto-resolve
  // strip in the panel.
  const promoteComments = async (
    cs: LocalComment[],
    modelId: string,
    mode: "active" | "new" | "queue"
  ) => {
    if (cs.length === 0) return;
    const ids = cs.map((c) => c.id);
    const placeholderTurnId = `promote-pending-${Date.now()}`;
    markPromoted(activeProject.id, ids, placeholderTurnId);
    setChatTabSwitchKey((k) => k + 1);

    // Build the bundled prompt body.
    const fileLabel = cs[0]?.file ?? activeTab.route;
    const lines: string[] = [];
    if (cs.length === 1) {
      const c = cs[0];
      const sel = c.selector ? c.selector : "<file>";
      const txt = c.innerText ? ` — "${c.innerText.slice(0, 80)}"` : "";
      lines.push(
        `I have a note on /${fileLabel}:`,
        ``,
        `${sel}${txt}`,
        `"${c.body}"`,
      );
    } else {
      lines.push(`I have ${cs.length} notes on /${fileLabel}:`, ``);
      cs.forEach((c, i) => {
        const sel = c.selector ? c.selector : "<file>";
        const snip = c.innerText ? ` — "${c.innerText.slice(0, 80)}"` : "";
        const body = c.body.split("\n").map((l) => `    ${l}`).join("\n");
        lines.push(`[${i + 1}] ${sel}${snip}`);
        lines.push(`${body}`);
        if (c.thumbnail) lines.push(`    [thumbnail attached as #${i + 1}]`);
        lines.push("");
      });
      lines.push(`Please address all. If any conflict, ask first.`);
    }
    const text = lines.join("\n");

    // One screenshot per comment: prefer the saved thumbnail (captured
    // when the user clicked the element), else best-effort fresh route
    // shot. Failing that we just drop the slot — the body still names
    // the selector so Claude can re-derive context.
    const attachments: Attachment[] = [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      let dataUrl = c.thumbnail;
      if (!dataUrl && iframeRef.current) {
        try {
          dataUrl = await captureIframeAsDataUrl(iframeRef.current, {
            scale: c.selector ? 1 : 0.5,
            selector: c.selector || undefined,
          });
        } catch { /* best-effort */ }
      }
      if (dataUrl) {
        attachments.push({ dataUrl, name: `comment-${i + 1}.png` });
      }
    }

    // First comment with a selector becomes the anchored target so the
    // server's prompt builder still gets a single primary element.
    const anchor = cs.find((c) => !!c.selector);
    const anchorDescriptor = (() => {
      if (!anchor) return undefined;
      const doc = iframeRef.current?.contentDocument ?? null;
      const el = doc ? (resolveCssPath(doc, anchor.selector) as HTMLElement | null) : null;
      return el ? buildDescriptor(el) : undefined;
    })();
    const target: CommentTarget | null = anchor
      ? ({
          x: 0, y: 0, localX: 0, localY: 0,
          selector: anchor.selector,
          tag: anchor.tag ?? "",
          innerText: anchor.innerText,
          outerHtml: undefined,
          descriptor: anchor.descriptor ?? anchorDescriptor,
          // Prefer the kind captured at comment time (computed style was
          // live then). Fall back to a fresh classification — tag-only,
          // good enough for h1/button/a/img.
          kind: anchor.kind ?? (anchorDescriptor
            ? classifyKind({ descriptor: anchorDescriptor })
            : undefined),
        } as CommentTarget)
      : null;

    // Dispatch.
    //   - "queue"  → drop into the one-slot queue regardless of state.
    //                Will fire when the in-flight turn drains.
    //   - "new"    → spawn a thread, then runTurn directly.
    //   - "active" → queueOrSend (respects the in-flight lock).
    let targetThreadId = activeThread?.id;
    try {
      if (mode === "queue") {
        const tid = activeThread?.id ?? null;
        if (!tid) {
          // No active thread — degrade to "new" so the queue has a home.
          const fresh = startNewThread(generateThreadTitleFromComment(cs[0]));
          targetThreadId = fresh.id;
          // eslint-disable-next-line react-hooks/purity
          setQueued({
            text, attachments, modelId,
            queuedAt: Date.now(),
            threadId: fresh.id,
            target,
          });
        } else {
          // eslint-disable-next-line react-hooks/purity
          setQueued({
            text, attachments, modelId,
            queuedAt: Date.now(),
            threadId: tid,
            target,
          });
        }
        // Queued sends are fire-and-forget from here — the drain effect
        // will run runTurn when the stream settles. The placeholder
        // turnId stays on the comments until the drain succeeds; on
        // explicit dequeue (user hits × on the queued bubble) the
        // comments would visually stay "Promoted" with a stale ref.
        // TODO(comments-agent): subscribe to the drain's assistant
        // turnId to upgrade the placeholder + show the auto-resolve
        // strip for queue-mode promotions.
        return;
      }

      if (mode === "new") {
        const fresh = startNewThread(generateThreadTitleFromComment(cs[0]));
        targetThreadId = fresh.id;
        await runTurn({ text, attachments, target, modelId, startNewThread: false });
      } else {
        // "active" — respect the in-flight lock via queueOrSend, but
        // we need to bypass its target snapshotting (it would use the
        // currently selected element, not our anchor). When unblocked
        // we call runTurn directly; when blocked, we fall back to the
        // one-slot queue ourselves (same shape as "queue" mode).
        if (isBlocked && activeThread) {
          // eslint-disable-next-line react-hooks/purity
          setQueued({
            text, attachments, modelId,
            queuedAt: Date.now(),
            threadId: activeThread.id,
            target,
          });
          return;
        }
        await runTurn({ text, attachments, target, modelId });
      }
    } catch (err) {
      console.warn("[promote] runTurn threw", err);
      clearPromoted(activeProject.id, ids);
      return;
    }

    // Post-stream lifecycle.
    //   - The stream is `done` by the time runTurn resolves (startStream
    //     awaits the SSE pump).
    //   - Pull the assistant message we just appended (the LATEST one in
    //     the resolved thread) and use its turnId / error to decide.
    //   - Use the function-form setThreads to read fresh state.
    let resolvedTurnId: string | undefined;
    let hadError = false;
    setThreads((prev) => {
      const t = prev.find((x) => x.id === (targetThreadId ?? activeThreadId));
      if (!t) return prev;
      const last = t.messages[t.messages.length - 1];
      if (last && last.role === "assistant") {
        resolvedTurnId = last.turnId;
        hadError = !!last.error;
      }
      return prev;
    });

    if (hadError) {
      clearPromoted(activeProject.id, ids);
      return;
    }
    if (resolvedTurnId) {
      // Upgrade placeholder → real turnId so undo can roll us back.
      markPromoted(activeProject.id, ids, resolvedTurnId);
    }
    // Surface the auto-resolve strip.
    setAutoResolvePromptIds(ids);
  };

  function generateThreadTitleFromComment(c: LocalComment | undefined): string {
    if (!c) return `Promoted comments · ${formatTime(Date.now())}`;
    const txt = (c.innerText || c.body || "").trim().replace(/\s+/g, " ");
    if (!txt) return generateThreadTitle(c.body || "Promoted comments");
    return generateThreadTitle(txt);
  }

  // Drain the queue once the turn ends. We watch `isBlocked` flipping
  // false, plus the `queued` slot being populated, plus the active
  // thread still being the one we queued on — and fire the message
  // through the same runTurn path. Clear the slot first so a re-render
  // race doesn't double-fire.
  useEffect(() => {
    if (!queued) return;
    if (isBlocked) return;
    if (!activeThread || activeThread.id !== queued.threadId) return;
    const q = queued;
    // setState-in-effect intentional: the drain reacts to an external
    // signal (the turn ending) flipping `isBlocked` false; clearing the
    // slot before fire-off prevents a re-render race from double-firing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueued(null);
    runTurn({
      text: q.text,
      attachments: q.attachments,
      target: q.target,
      modelId: q.modelId,
      includeCanvas: q.includeCanvas,
      preamble: q.preamble,
    });
    // runTurn is stable enough — captured in a closure above. The deps
    // we care about are isBlocked + queued + activeThread identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBlocked, queued, activeThread?.id]);

  // If the user switches threads (or the queued thread vanishes), drop
  // the queued message — firing it into a different session would be
  // surprising and the `sessionId` would mismatch the user's mental
  // model anyway.
  useEffect(() => {
    if (!queued) return;
    if (!activeThread || activeThread.id !== queued.threadId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQueued(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id]);

  // ?fresh=1 means the user JUST created this project — kick off an
  // intake conversation so Claude asks what they want to design before
  // touching any file (the "ask 5-10 questions before building"
  // workflow). Strip the flag immediately so a refresh doesn't re-fire
  // the intake.
  // Track per-project so an in-place project switch (without
  // remounting the route) still fires intake for the new project.
  const intakeFiredFor = useRef<Set<string>>(new Set());
  const [chatTabSwitchKey, setChatTabSwitchKey] = useState(0);
  // Per-project flag: this project hasn't yet received the intake brief.
  // Set when the user lands with `?fresh=1`; consumed by queueOrSend on
  // the user's first message — that turn rides the intake along as a
  // hidden `preamble` (visible to Claude, not in the bubble) so the
  // user sees a calm welcome screen first instead of a wall of pre-
  // fired instructions before they've typed anything.
  const [pendingIntakeFor, setPendingIntakeFor] = useState<string | null>(null);
  useEffect(() => {
    if (params.get("fresh") !== "1") return;
    if (intakeFiredFor.current.has(activeProject.id)) return;
    intakeFiredFor.current.add(activeProject.id);
    setChatTabSwitchKey((k) => k + 1);
    setParams((next) => { next.delete("fresh"); return next; }, { replace: true });
    setPendingIntakeFor(activeProject.id);
  }, [params, setParams, activeProject?.id]);

  // Same brief that used to auto-fire as a giant hidden user message.
  // Now generated lazily and ridden as `preamble` on the user's first
  // turn. Brain unchanged — only the delivery moment changes.
  const buildIntakePreamble = useCallback((): string => {
    const projectName = activeProject.name;
    // The wrapping prompt (api/src/routes/commentEdit.ts → buildSandboxPrompt)
    // already tells Claude about the sandbox, manifest, and conventions.
    // This intake message just kicks off the *workflow*: ask first, build
    // later — step 1 is "understand user needs; ask clarifying questions
    // for new/ambiguous work."
    return [
      `New project: "${projectName}". Fresh sandbox — index.html and style.css are starter scaffolding.`,
      ``,
      `**Don't touch any file yet.** First, understand what I want. Follow this order:`,
      ``,
      `1. **Open with one structured question** via \`mcp__ask-user__ask_user\` to nail down the artifact type. Use \`kind: "enum"\` with options like:`,
      `   "Lower third", "Titling system", "Thumbnail", "Opening title", "Animated overlay", "Episode card", "Other"`,
      ``,
      `2. Once I pick, follow up with **5–8 more questions**. Mix structured (\`ask_user\`) and prose. Cover:`,
      `   • aspect ratio / platform (YouTube 16:9, Shorts 9:16, podcast 1:1, etc.)`,
      `   • tone & aesthetic direction (editorial, broadcast, cinematic, brutalist, soft-minimal, etc.)`,
      `   • brand context — existing system, references to upload, or starting from scratch?`,
      `   • how many variations and across which dimensions (color, layout, motion, copy)?`,
      `   • constraints (safe areas, broadcast-safe colors, copy length, motion timing)`,
      ``,
      `3. After I've answered, **invoke the \`frontend-design\` skill** (via the Skill tool) for guidance on committing to a bold aesthetic direction before writing any code.`,
      ``,
      `4. Then plan briefly (one short paragraph), and only then start building inside the sandbox dir.`,
      ``,
      `Don't ask all questions at once — one form at a time, conversational. Don't read the starter files yet; they're just empty scaffolding.`,
      ``,
      `---`,
      ``,
      `My request follows below:`,
    ].join("\n");
  }, [activeProject.name]);

  // Active tab id lives on the project. Falls back to the first tab.
  const activeTabId = activeProject.activeTabId ?? activeProject.openTabs[0]?.id ?? "";
  const setActiveTabId = useCallback((id: string) => {
    updateProject(activeProject.id, { activeTabId: id });
  }, [activeProject.id]);

  // Honor ?file=/route (preferred) or legacy ?tab=/route to preselect a
  // tab on first render. If the requested route isn't already a tab, open
  // it as a new tab and activate it.
  useEffect(() => {
    const wanted = params.get("file") ?? params.get("tab");
    if (!wanted) return;
    const existing = tabs.find((t) => t.route === wanted);
    if (existing) {
      if (existing.id !== activeTabId) setActiveTabId(existing.id);
      return;
    }
    const t: Tab = { id: uniqueTabId(), label: routeToLabel(wanted), route: wanted, display: defaultDisplay(wanted) };
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    trackEvent("tab_open", { route: wanted, source: "param" }, activeProject.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, activeProject.id]);
  const [mode, setMode] = useState<Mode>("select");
  const [zoom, setZoom] = useState<number>(0.5);
  const [selected, setSelected] = useState<SelectedInfo | null>(null);
  /** Imperative handle on the CanvasFrame for hover painting from
   *  outside the iframe (e.g. the Layers panel hover). Hover lives
   *  outside React state to avoid re-rendering this component on
   *  every mouse twitch — see CanvasFrame's paintHover for why. */
  const canvasFrameRef = useRef<CanvasFrameHandle | null>(null);
  /** All currently-selected selectors. Always includes `selected.selector`
   * if non-null. Mutations apply to every entry. */
  const [selectionList, setSelectionList] = useState<string[]>([]);
  // Project title is the active project's name — editing it renames the project.
  const projectTitle = activeProject.name;
  const setProjectTitle = useCallback((next: string) => {
    updateProject(activeProject.id, { name: next });
  }, [activeProject.id]);

  const isDesignFiles = activeTabId === DESIGN_FILES_TAB_ID;
  // When the synthetic Design Files tab is active, fall back to the first
  // real tab so downstream handlers (toolbar callbacks, applyToSelection)
  // still resolve a route without null-checking everywhere. The toolbar +
  // canvas don't render in this mode, so the fallback only matters for
  // memoized callbacks that capture activeTab.route.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // ─── URL ↔ state sync ────────────────────────────────────────
  // The URL carries `?p=<projectId>&file=<route>` so links are
  // shareable: paste a URL, land on that project + file. We only act
  // on URL changes that arrived from *outside* this component (initial
  // mount, browser back/forward, pasted link) — when the user clicks
  // the project switcher, state changes first and the URL still holds
  // the old value on the next render; without this guard the read
  // effect would see the stale URL and revert the switch.
  const lastSyncedProject = useRef<string>(activeProject.id);
  useEffect(() => {
    const wantedProject = params.get("p");
    if (!wantedProject) return;
    if (wantedProject === lastSyncedProject.current) return;
    if (wantedProject === activeProject.id) {
      lastSyncedProject.current = wantedProject;
      return;
    }
    void (async () => {
      const hydrated = await hydrateProjectFromServer(wantedProject);
      if (hydrated) {
        lastSyncedProject.current = wantedProject;
        setActiveProject(wantedProject);
      }
    })();
  }, [params, activeProject.id]);

  // Mirror state → URL. Keep the params we care about (`p`, `file`)
  // in sync; preserve everything else the user might have on the URL
  // (e.g. dev tooling adds its own).
  useEffect(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      let dirty = false;
      if (next.get("p") !== activeProject.id) {
        next.set("p", activeProject.id);
        dirty = true;
      }
      const route = activeTab?.route;
      if (route && next.get("file") !== route) {
        next.set("file", route);
        dirty = true;
      } else if (!route && next.has("file")) {
        next.delete("file");
        dirty = true;
      }
      if (dirty) lastSyncedProject.current = activeProject.id;
      return dirty ? next : prev;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject.id, activeTab?.route]);
  // File paths that are open in editor tabs, used by the file panels to
  // draw an "open in tab" dot. Strip the synthetic _preview/ wrapper used
  // by component routes so the set matches raw file.path strings.
  const openRoutes = useMemo(() => {
    const out = new Set<string>();
    for (const t of tabs) {
      if (t.id === DESIGN_FILES_TAB_ID) continue;
      const r = t.route.startsWith("_preview/") ? t.route.slice("_preview/".length) : t.route;
      if (r) out.add(r);
    }
    return out;
  }, [tabs]);
  const activeRoute = activeTab.route.startsWith("_preview/")
    ? activeTab.route.slice("_preview/".length)
    : activeTab.route;
  // Cmd-clicking an editor tab pulses + scrolls to the matching row in
  // FileBrowserView. The nonce forces FileBrowserView's effect to refire
  // even when the path is the same as the previous request.
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null);
  const revealInBrowser = useCallback((route: string) => {
    const stripped = route.startsWith("_preview/") ? route.slice("_preview/".length) : route;
    if (!stripped) return;
    setActiveTabId(DESIGN_FILES_TAB_ID);
    setRevealRequest({ path: stripped, nonce: Date.now() });
  }, []);
  // External-edit detection. The server already runs an fs.watch per
  // project for iframe hot-reload; we tap the same SSE channel and turn
  // each tick into a `files:invalidate` event so the panels refetch when
  // the user (or another tool) edits files outside chat.
  useEffect(() => {
    const id = activeProject?.id;
    if (!id) return;
    const es = new EventSource(`/p/${encodeURIComponent(id)}/__reload`);
    const onMsg = () => window.dispatchEvent(new CustomEvent("files:invalidate"));
    es.addEventListener("message", onMsg);
    return () => { es.removeEventListener("message", onMsg); es.close(); };
  }, [activeProject?.id]);

  // Cmd/Ctrl+P opens the quick file switcher. Suppressed when the user is
  // already typing in another input/textarea so we don't hijack their flow.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Cmd/Ctrl+/ opens the keyboard-shortcuts cheat sheet. Same suppression
  // rule — typing "/" in chat composer mustn't hijack into this modal.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Persist any pending inspector overrides for the active route to
   *  the project's _inspector_edits.css. Shared by the Inspector save
   *  button and the Cmd/Ctrl+S keyboard shortcut. */
  const saveInspectorEdits = useCallback(async () => {
    const overrides = readRoute(activeTab.route);
    if (Object.keys(overrides).length === 0) return;
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(activeProject.id)}/inspector-css`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ route: activeTab.route, edits: overrides }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      clearRoute(activeTab.route);
      const ifr = iframeRef.current;
      if (ifr) DmBridge.injectInspectorCSS(ifr, Date.now());
      canvasFrameRef.current?.reloadFrame();
      trackEvent("inspector_save", { count: String(Object.keys(overrides).length) }, activeProject.id);
      toast.success("Inspector edits saved.");
    } catch (err) {
      toast.error(`Couldn't save inspector edits: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeProject.id, activeTab.route]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
        if (inField) return;
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        if (inField) return;
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // ? (Shift+/) — open the shortcuts cheat sheet without a modifier.
      // Suppressed inside any input so users can still type "?" in chat.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (inField) return;
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // Cmd/Ctrl+B — toggle the LeftPanel collapsed state. Dispatched as
      // a window event so the panel listens without prop-drilling.
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        if (inField) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("leftpanel:toggle"));
        return;
      }
      // Cmd/Ctrl+S — flush pending inspector edits. Always wins over the
      // browser's "Save Page As" since the user explicitly bound it.
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (inField) return;
        void saveInspectorEdits();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveInspectorEdits]);
  // Reactive stroke list for the active route — drives the Draw bar's
  // Send/Undo enabled-state and the composite-on-send pipeline.
  const routeStrokes = useStrokes(activeTab.route);
  // Default to red — high-contrast, matches the "highlighter" mental
  // model people bring to scribbling on screenshots. Picker in the
  // Draw action bar lets users switch.
  const [drawColor, setDrawColor] = useState<string>("#e0524d");

  // Export options for the click-to-export PNG/JPG flow. Scale + format +
  // background apply to every element captured while in export mode; the
  // popover (anchored to the toolbar Export button) lets the user change
  // them between captures.
  const [exportScale, setExportScale] = useState<number>(2);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [exportBg, setExportBg] = useState<"transparent" | "white">("transparent");
  // Video-specific options. The popover only surfaces these when format=video.
  const [videoResolution, setVideoResolution] = useState<"1080p" | "1440p" | "4K" | "8K">("1080p");
  const [videoQuality, setVideoQuality] = useState<"draft" | "standard" | "high" | "master">("standard");
  // "auto" means: recorder detects the natural animation length from
  // CSS / Lottie. Default — matches what the user expects ("loop my
  // animation once") without an explicit choice.
  const [videoDuration, setVideoDuration] = useState<number | "auto">("auto");
  const [videoFps, setVideoFps] = useState<24 | 30 | 60>(30);
  const [videoBg, setVideoBg] = useState<"transparent" | "black" | "white">("transparent");
  // True while the actual capture is running (after the user clicks Capture).
  // Lets the popover button show "Capturing…" instead of "Capture".
  const [exportCapturing, setExportCapturing] = useState(false);

  /** Capture the currently-selected element. The popover's Capture button
   *  fires this; the click handler in CanvasFrame only sets `selected` so
   *  the user can correct a wrong child-hit before committing. */
  const onCaptureExport = useCallback(async () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !selected) return;
    const el = resolveCssPath(doc, selected.selector) as HTMLElement | null;
    if (!el) return;
    setExportCapturing(true);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      // ── Video (MP4 / ProRes 4444) ─────────────────────────────────
      // Records the element via Playwright + ffmpeg. Resolution drives
      // deviceScaleFactor (vector content stays crisp at 4K because the
      // browser re-rasterizes at higher DPI; raster sources are bounded
      // by their natural resolution). Background='transparent' produces
      // ProRes 4444 .mov with real alpha; black/white produce H.264 .mp4
      // (use Composite Mode 'Add' in Resolve to luma-key the black bg).
      if (exportFormat === "video") {
        const baseName = `${selected.tag}-${videoResolution}-${stamp}`;
        const res = await fetch("/api/export-video", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: activeProject.id,
            route: activeTab.route,
            selector: selected.selector,
            resolution: videoResolution,
            quality: videoQuality,
            duration: videoDuration,
            fps: videoFps,
            backgroundColor: videoBg,
            name: baseName,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          toast.error(`Video export failed: ${err?.error ?? `HTTP ${res.status}`}`);
          return;
        }
        const artifact = await res.json();
        const codecLabel = artifact.metadata?.codec || "video";
        const dimsLabel = artifact.metadata?.width && artifact.metadata?.height
          ? `${artifact.metadata.width}×${artifact.metadata.height}`
          : "";
        const durLabel = artifact.metadata?.duration ? `${artifact.metadata.duration}s` : "";
        pushArtifactToChat(
          artifact,
          `Saved \`${artifact.filename}\` — ${codecLabel}${dimsLabel ? ` · ${dimsLabel}` : ""}${durLabel ? ` · ${durLabel}` : ""}.`,
        );
        return;
      }

      // ── Lottie passthrough ─────────────────────────────────────────
      // If the selection contains a <lottie-player> / <dotlottie-player>,
      // hand the source .json/.lottie file straight to the user. No
      // rasterization, no bundling — the file is already the right
      // format for Resolve 21+ Media Pool import.
      if (exportFormat === "lottie") {
        const findLottie = (root: Element | Document): { src: string; tag: string } | null => {
          if (root instanceof Element) {
            const tag = root.tagName.toLowerCase();
            if (tag === "lottie-player" || tag === "dotlottie-player") {
              const src = root.getAttribute("src");
              if (src) return { src, tag };
            }
          }
          const inner = root.querySelector("lottie-player, dotlottie-player");
          if (inner) {
            const src = inner.getAttribute("src");
            if (src) return { src, tag: inner.tagName.toLowerCase() };
          }
          return null;
        };
        // Look in the selection first — if nothing there, fall back to
        // the whole iframe doc and ask before using it. Common case: the
        // user selected an SVG fallback that <lottie-player> swaps over,
        // but the player itself is elsewhere on the page.
        let lottie = findLottie(el);
        if (!lottie) {
          const pageWide = findLottie(doc);
          if (pageWide) {
            const ok = confirm(
              `No <lottie-player> in your selection, but one is on this page:\n\n${pageWide.src}\n\nExport that one instead?`,
            );
            if (!ok) return;
            lottie = pageWide;
          }
        }
        if (!lottie) {
          toast.warn(
            "No Lottie player found on this page. Add a <lottie-player> or " +
              "<dotlottie-player> tag with a src attribute, or load via DOM " +
              "so the source URL can be detected.",
            { durationMs: 6000 },
          );
          return;
        }
        try {
          // Resolve relative srcs against the iframe's baseURI before
          // handing to the API — the server fetches the bytes and saves
          // them under the project's exports/ so the result shows up in
          // chat as a normal artifact (no auto-download).
          const absUrl = new URL(lottie.src, doc.baseURI).toString();
          const res = await fetch("/api/export-lottie", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: activeProject.id,
              src: absUrl,
              name: `${selected.tag}-${stamp}`,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            toast.error(`Lottie export failed: ${err?.error ?? `HTTP ${res.status}`}`);
            return;
          }
          const artifact = await res.json();
          pushArtifactToChat(
            artifact,
            `Saved \`${artifact.filename}\` — Lottie source for DaVinci Resolve 21+ Media Pool.`,
          );
        } catch (err) {
          console.error("[export] Lottie fetch failed:", err);
          toast.error(`Lottie fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // ── OGraf (HTML graphics for DaVinci Resolve 21+) ──────────────
      // Generates an .ograf.zip bundle on the server. No client-side
      // fallback — if the bundle endpoint fails, surface the reason.
      if (exportFormat === "ograf") {
        const baseName = `${selected.tag}-${stamp}`;
        const res = await fetch("/api/export-ograf", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: activeProject.id,
            route: activeTab.route,
            selector: selected.selector,
            name: baseName,
            editableTitle: true,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          console.error("[export] OGraf failed:", err);
          toast.error(`OGraf export failed: ${err?.error ?? `HTTP ${res.status}`}`);
          return;
        }
        // Server saved the bundle to web/projects/<id>/exports/. Surface
        // it as an inline ArtifactCard in chat — the user clicks the
        // card's Download button if/when they want a local copy. No
        // more auto-download (the user asked for this explicitly).
        const artifact = await res.json();
        pushArtifactToChat(
          artifact,
          `Saved \`${artifact.filename}\` — OGraf bundle for DaVinci Resolve 21+ Media Pool.`,
        );
        return;
      }

      // ── Raster path: server-side Playwright primary, modern-
      // screenshot fallback. Real Blink output handles <canvas>,
      // <video>, backdrop-filter, mix-blend-mode.
      const filename = `${selected.tag}-${exportScale}x-${stamp}.${exportFormat}`;
      let serverReason: string | null = null;
      try {
        const res = await fetch("/api/export-element", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: activeProject.id,
            route: activeTab.route,
            selector: selected.selector,
            scale: exportScale,
            format: exportFormat === "jpg" ? "jpeg" : "png",
            backgroundColor: exportBg,
            name: `${selected.tag}-${exportScale}x-${stamp}`,
          }),
        });
        if (res.ok) {
          const artifact = await res.json();
          const fmt = (artifact.mime || "").includes("jpeg") ? "JPEG" : "PNG";
          const dims = artifact.metadata?.scale ? ` · ${artifact.metadata.scale}×` : "";
          pushArtifactToChat(
            artifact,
            `Saved \`${artifact.filename}\` — ${fmt}${dims}.`,
          );
          return;
        }
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        serverReason = err?.error ?? `HTTP ${res.status}`;
      } catch (err) {
        serverReason = err instanceof Error ? err.message : String(err);
      }
      console.warn("[export] server render unavailable, falling back:", serverReason);

      try {
        // The OGraf branch above already returned, so exportFormat here
        // is png|jpg only — but TS narrows on the variable, not the
        // value. Cast through `unknown` to make the comparison legal.
        const rasterFormat: "png" | "jpg" =
          (exportFormat as unknown) === "jpg" ? "jpg" : "png";
        const dataUrl = await captureElementAsDataUrl(el, {
          scale: exportScale,
          format: rasterFormat,
          backgroundColor: exportBg === "white" ? "#ffffff" : undefined,
        });
        // Client-side fallback path — no server artifact, so we can't
        // surface a chat card the same way (the file isn't on disk).
        // Trigger a download AND warn so the user knows this path
        // bypasses the project library.
        downloadDataUrl(dataUrl, filename);
        console.warn("[export] used client-side fallback (no server) — file not saved to project library");
      } catch (err) {
        console.error("[export] capture failed", err);
        toast.error("Export failed. Check the console for details.");
      }
    } finally {
      setExportCapturing(false);
    }
  }, [selected, exportScale, exportFormat, exportBg, activeTab.route, activeProject.id]);

  /** Walk the export selection up one level — fixes the common "click hit
   *  a child <span> inside the card I wanted" problem without forcing the
   *  user to re-click. */
  const onWalkExportParent = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !selected) return;
    const el = resolveCssPath(doc, selected.selector) as HTMLElement | null;
    const parent = el?.parentElement ?? null;
    if (!parent) return;
    const tag = parent.tagName.toLowerCase();
    if (tag === "body" || tag === "html") return;
    const newSel = cssPath(parent);
    const computed = doc.defaultView!.getComputedStyle(parent);
    const descriptor = buildDescriptor(parent);
    setSelected({ selector: newSel, tag, computed, descriptor });
  }, [selected]);

  // Live-tweak bridge: listens for the iframe page declaring
  // __edit_mode_available, posts __activate/__deactivate when the
  // toolbar toggle is clicked, and rewrites the EDITMODE-marked JSON
  // block on every __edit_mode_set_keys via /api/projects/:id/tweak.
  // This is the host side of the `make-tweakable` skill.
  const tweakBridge = useTweakBridge({
    iframeRef,
    projectId: activeProject.id,
    activeFile: activeTab?.route ?? "",
  });
  // Live count of inspector overrides for the active route — drives the
  // "Save N edits" badge on the toolbar (hidden when 0).
  const overrideCountForActive = useOverrideCount(activeTab?.route ?? "");
  // Set of routes with at least one inspector override — drives the
  // dirty-mark on each non-active tab in the strip (#34).
  const dirtyRoutes = useDirtyRoutes();

  /** Clears inspector edits for a route from BOTH layers:
   *   - localStorage (clearRoute), so the badge resets
   *   - _inspector_edits.css on disk (POST empty edits to the server),
   *     so the !important rules don't shadow source after a bake or
   *     manual discard.
   *  Used by Reset and after a successful "Bake to source" run. */
  const clearRouteEverywhere = useCallback(async (route: string) => {
    if (!route) return;
    clearRoute(route);
    try {
      await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/inspector-css`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route, edits: {} }),
      });
    } catch { /* best-effort — localStorage is the user-visible truth */ }
  }, [activeProject.id]);

  // If the iframe page declares itself as a canvas (workshop), snap the
  // display mode back to "fill" — frame mode would be canvas-in-canvas.
  // We only run this when the canvas flag flips on; once snapped the
  // user can still leave the page or switch tabs to use frame mode again.
  useEffect(() => {
    if (!tweakBridge.isCanvas) return;
    if (!activeTab) return;
    if (activeTab.display !== "frame") return;
    const targetId = activeTab.id;
    setTabs((prev) => prev.map((t) => (t.id === targetId ? { ...t, display: "fill" } : t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tweakBridge.isCanvas, activeTab?.id]);

  /** Pick a comment pin AND make sure its file is the active tab. Used
   *  by the Comments tab in LeftPanel — clicking a comment there should
   *  jump the canvas to where the user left it. */
  const selectPinAndJump = useCallback((id: string | null) => {
    setSelectedPinId(id);
    if (!id) return;
    const all = listComments(activeProject.id);
    const c = all.find((x) => x.id === id);
    if (!c) return;
    const existing = tabs.find((t) => t.route === c.file);
    if (existing) {
      if (existing.id !== activeTabId) setActiveTabId(existing.id);
    } else {
      const t: Tab = {
        id: uniqueTabId(),
        label: routeToLabel(c.file) || c.file,
        route: c.file,
        display: defaultDisplay(c.file),
      };
      setTabs((prev) => [...prev, t]);
      setActiveTabId(t.id);
    }
  }, [activeProject.id, tabs, activeTabId, setActiveTabId, setTabs]);

  // Pinned tabs render first, in their original insertion order; unpinned
  // follow. Re-ordering happens in TabBar via this prop, not by mutating
  // the underlying tabs array.
  const orderedTabs = useMemo(
    () => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)],
    [tabs],
  );
  const setTabPinned = useCallback((id: string, pinned: boolean) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, pinned } : t));
  }, [setTabs]);
  const setTabLabel = useCallback((id: string, label: string) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, label } : t));
  }, [setTabs]);

  /** Open a project-relative file as a regular editor tab (or activate
   *  it if it's already open). Used by both the LeftPanel files list and
   *  the canvas-area FileBrowserView. */
  const openRouteAsTab = useCallback((route: string, label: string) => {
    const existing = tabs.find((t) => t.route === route);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: uniqueTabId(),
      label: routeToLabel(route) || label,
      route,
      display: defaultDisplay(route),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    trackEvent("tab_open", { route, source: "files-panel" }, activeProject.id);
  }, [tabs, setActiveTabId, setTabs, activeProject.id]);

  // Apply a CSS prop to every selector in the current selection.
  // Routes through the DM command bus when the element has been stamped
  // with `data-dm-ref` (which the inject-script does lazily on the first
  // pick/hover/describe touching it), otherwise falls back to a direct
  // style mutation. Same visual outcome; only difference is whether the
  // mutation lands in the DM closure-undo stack.
  const applyToSelection = useCallback((prop: string, value: string) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const sels = selectionList.length > 0
      ? selectionList
      : (selected ? [selected.selector] : []);
    if (sels.length === 0) return;
    const dm = dmRef.current;
    for (const sel of sels) {
      const el = resolveCssPath(doc, sel) as HTMLElement | null;
      if (!el) continue;
      let ref = el.getAttribute("data-dm-ref");
      if (!ref) {
        // The inject-script stamps lazily — elements that haven't been
        // picked/hovered/described yet have no ref. Pre-stamp here with
        // a host-side ID so domSnapshot can capture this element's
        // pre-mutation style and restoreDomSnapshot can roll it back.
        // Using a high prefix (1e9+) keeps us out of the inject-script's
        // own counter range; if its getRef ever sees this element it
        // will read the existing attribute and reuse our ID.
        ref = String(hostStampCounter.current++);
        el.setAttribute("data-dm-ref", ref);
      }
      if (dm) {
        dm.send({ type: "setStyles", ref, styles: { [prop]: value } });
      } else {
        // No bus available (e.g. iframe still loading). Mutate directly;
        // visual outcome is the same. Live-preview must use !important
        // — saved inspector edits land in _inspector_edits.css with
        // !important, and inline styles without it would silently lose
        // to that file once the user has hit Save once on the route.
        el.style.setProperty(prop, value, "important");
      }
      setOverride(activeTab.route, sel, prop, value);
    }
    // We deliberately do NOT call setSelected with a fresh `getComputedStyle`
    // here. The DM bus mutation is async (postMessage), so an immediate
    // computed-style read would return the *pre-mutation* values. Pushing
    // those back through `useState` resets the Inspector's vals on every
    // keystroke and clobbers what the user just typed. The input fields
    // own their own state via `vals`; the iframe owns the visual state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectionList, activeTab.route]);

  return (
    <div className={s.shell}>
      {paletteOpen && (
        <Suspense fallback={null}>
          <QuickSwitcher
            projectId={activeProject.id}
            onOpenRoute={openRouteAsTab}
            onClose={() => setPaletteOpen(false)}
          />
        </Suspense>
      )}
      {shortcutsOpen && (
        <Suspense fallback={null}>
          <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      )}
      <TabBar
        projectTitle={projectTitle}
        onRenameProject={setProjectTitle}
        tabs={orderedTabs}
        activeId={activeTabId}
        onReveal={revealInBrowser}
        onActivate={(id) => {
          setActiveTabId(id);
          setSelected(null);
          trackEvent("tab_switch", { id }, activeProject.id);
        }}
        onClose={(id) => {
          setTabs((prev) => {
            const next = prev.filter((t) => t.id !== id);
            if (next.length === 0) return prev;
            if (id === activeTabId) setActiveTabId(next[0].id);
            trackEvent("tab_close", {}, activeProject.id);
            return next;
          });
        }}
        onSetPinned={setTabPinned}
        onRename={setTabLabel}
        onAdd={() => setTemplatesOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        dirtyRoutes={dirtyRoutes}
        onReorder={(fromId, toId) => {
          setTabs((prev) => {
            const fromIdx = prev.findIndex((t) => t.id === fromId);
            const toIdx = prev.findIndex((t) => t.id === toId);
            if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
            // Pinned tabs sort to the front in `orderedTabs`; we don't
            // let unpinned land before pinned (or vice-versa) in the
            // underlying array — the consumer's pinned-first sort would
            // just snap them back. Bail when the move would cross the
            // pin boundary.
            const moving = prev[fromIdx];
            const dest = prev[toIdx];
            if (!!moving.pinned !== !!dest.pinned) return prev;
            const next = prev.slice();
            const [item] = next.splice(fromIdx, 1);
            const insertAt = next.findIndex((t) => t.id === toId);
            next.splice(insertAt, 0, item);
            trackEvent("tab_reorder", {}, activeProject.id);
            return next;
          });
        }}
        onCloseMany={(predicate) => {
          setTabs((prev) => {
            const next = prev.filter((t) => !predicate(t));
            if (next.length === 0) {
              setActiveTabId(DESIGN_FILES_TAB_ID);
              return prev;
            }
            if (!next.some((t) => t.id === activeTabId)) setActiveTabId(next[0].id);
            trackEvent("tab_close_many", { count: String(prev.length - next.length) }, activeProject.id);
            return next;
          });
        }}
      />

      <div className={s.stage}>
        <LeftPanel
          projectId={activeProject.id}
          threads={threads}
          activeThread={activeThread}
          activeFile={activeTab.route}
          composerContext={
            // Show the picked element whenever there IS one — both Edit
            // (inspector mode) and Select (no tool) populate `selected`,
            // so the chat always knows what the user is pointing at.
            // The pill is medium-width; the smart label collapses real
            // semantic tags ("Heading" for an <h1>) and reveals the
            // structural truth on heading-styled divs ("Heading · div .title").
            selected
              ? `${activeTab.route} · ${smartLabel({
                  descriptor: selected.descriptor,
                  tag: selected.tag,
                  computed: computedHints(selected.computed),
                }).medium}`
              : activeTab.route
          }
          onClearComposerContext={selected ? () => {
            setSelected(null);
            setSelectionList([]);
          } : undefined}
          chatTabSwitchKey={chatTabSwitchKey}
          pendingElicit={pendingElicit?.request ?? null}
          onElicitResolved={() => setPendingElicit(null)}
          onStop={() => {
            // Abort the in-flight stream — server's req.on("close")
            // aborts the SDK query and cancels any pending elicitation.
            // Also tell the server to bypass the GRACE_DISCONNECT_MS
            // window so this is a real Stop, not a "user might come back".
            const t = activeThread;
            if (!t) return;
            const lastUser = [...t.messages].reverse().find((m) => m.role === "user") as
              | Extract<ChatMessage, { role: "user" }>
              | undefined;
            const streamId = lastUser?.streamId;
            const live = !!streamId && isStreamActive(streamId);
            if (live && streamId) {
              void notifyServerStop(streamId);
              abortStream(streamId);
            }
            setPendingElicit((p) => (p && p.threadId === t.id ? null : p));
            // No live stream to abort (page reloaded mid-turn, watchdog
            // missed the stall, etc.). The pending:true is just stale —
            // flip it locally so the composer unblocks. Save useEffect
            // will mirror the change to disk.
            if (!live) {
              setThreads((prev) => prev.map((th) => {
                if (th.id !== t.id) return th;
                const msgs = th.messages.slice();
                for (let i = msgs.length - 1; i >= 0; i--) {
                  const m = msgs[i];
                  if (m.role !== "assistant") continue;
                  if (!m.pending) break;
                  msgs[i] = { ...m, pending: false, error: m.error ?? "Stopped — no active stream." };
                  break;
                }
                return { ...th, messages: msgs };
              }));
            }
          }}
          onNewThread={() => startNewThread()}
          onSwitchThread={setActiveThreadId}
          onDeleteThread={(id) => {
            setThreads((prev) => {
              // Abort + detach any in-flight streams in the deleted
              // thread so we don't leak listeners or keep writing into
              // the cached archive after the thread is gone.
              const dying = prev.find((t) => t.id === id);
              if (dying) {
                for (const m of dying.messages) {
                  if (m.role === "user" && m.streamId) {
                    // Thread is being deleted — bypass grace, the
                    // assistant message is gone for good either way.
                    void notifyServerStop(m.streamId);
                    abortStream(m.streamId);
                    detachStream(m.streamId);
                  }
                }
              }
              const next = prev.filter((t) => t.id !== id);
              if (activeThreadId === id) {
                setActiveThreadId(next[0]?.id ?? null);
              }
              return next;
            });
          }}
          onRenameThread={renameThread}
          onRetry={retryTurn}
          onDeleteMessage={deleteMessagesFrom}
          selectedPinId={selectedPinId}
          onSelectPin={selectPinAndJump}
          onPromoteComments={(cs, modelId, mode) => {
            void promoteComments(cs, modelId, mode);
          }}
          captureRouteScreenshot={async () => {
            try {
              if (!iframeRef.current) return undefined;
              return await captureIframeAsDataUrl(iframeRef.current, { scale: 0.5 });
            } catch { return undefined; }
          }}
          autoResolvePromptIds={autoResolvePromptIds}
          onAutoResolveConfirm={(ids) => {
            bulkResolve(activeProject.id, ids, true);
            setAutoResolvePromptIds([]);
          }}
          onAutoResolveDismiss={() => setAutoResolvePromptIds([])}
          onSend={(text, attachments, modelId, opts) => {
            // Wrapped in queueOrSend: if a turn is still streaming
            // (or an elicit form is open) the message lands in the
            // one-slot queue instead of spawning a concurrent SDK
            // turn. Drained automatically when the turn ends — see
            // the queueOrSend / drain effect above.
            queueOrSend(text, attachments, modelId, opts);
          }}
          queuedMessage={queued && activeThread && queued.threadId === activeThread.id
            ? { text: queued.text, attachments: queued.attachments, modelId: queued.modelId, queuedAt: queued.queuedAt }
            : null}
          onCancelQueued={() => setQueued(null)}
          onRestore={(m) => {
            if (!m.domHtml && !m.styles) return;
            const result = restoreDomSnapshot(iframeRef.current, {
              html: m.domHtml,
              scrollX: m.scrollX,
              scrollY: m.scrollY,
              styles: m.styles,
            });
            if (!result.ok) return;
            if (result.mode === "wholesale") {
              const ifr = iframeRef.current;
              if (ifr) DmBridge.inject(ifr);
              setSelected(null);
              setSelectionList([]);
              setCommentTarget(null);
            }
            trackEvent("restore_used", { source: "chat", mode: result.mode }, activeProject.id);
          }}
          onRestoreComment={(c) => {
            if (!c.domHtml && !c.styles) return;
            const result = restoreDomSnapshot(iframeRef.current, {
              html: c.domHtml,
              scrollX: c.scrollX,
              scrollY: c.scrollY,
              styles: c.styles,
            });
            if (!result.ok) return;
            if (result.mode === "wholesale") {
              const ifr = iframeRef.current;
              if (ifr) DmBridge.inject(ifr);
              setSelected(null);
              setSelectionList([]);
              setCommentTarget(null);
            }
            trackEvent("restore_used", { source: "comment", mode: result.mode }, activeProject.id);
          }}
          onUndo={async (turnId) => {
            try {
              const r = await fetch("/api/comment-undo", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ turnId }),
              });
              if (!r.ok) {
                const t = await r.json().catch(() => ({}));
                throw new Error(t.error ?? `HTTP ${r.status}`);
              }
              setThreads((prev) => prev.map((t) =>
                t.id === activeThreadId
                  ? {
                      ...t,
                      messages: t.messages.map((m) =>
                        m.role === "assistant" && m.turnId === turnId ? { ...m, reverted: true } : m
                      ),
                    }
                  : t
              ));
            } catch (err) {
              toast.error(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
          onOpenSkillsSettings={openSkillsSettings}
        />

        <div className={s.right}>
          {!isDesignFiles && <Toolbar
            mode={mode}
            onMode={(m) => {
              setMode(m);
              // Selection persists across edit ↔ export so the popover can use
              // it as the capture target. Clear only when leaving both.
              if (m !== "edit" && m !== "export") setSelected(null);
              if (m !== "comment") setCommentTarget(null);
            }}
            zoom={zoom}
            onZoom={setZoom}
            showZoom={activeTab.display === "frame"}
            display={activeTab.display}
            onDisplay={(d) =>
              setTabs((prev) =>
                prev.map((t) => (t.id === activeTabId ? { ...t, display: d } : t))
              )
            }
            viewport={activeTab.viewport ?? DEFAULT_VIEWPORT}
            onViewport={(vp) =>
              setTabs((prev) =>
                prev.map((t) => (t.id === activeTabId ? { ...t, viewport: vp } : t))
              )
            }
            onClearStrokes={() => clearStrokes(activeTab.route)}
            exportScale={exportScale}
            onExportScale={setExportScale}
            exportFormat={exportFormat}
            onExportFormat={(f) => {
              setExportFormat(f);
              // JPG can't carry alpha — flip background to white when JPG is picked.
              if (f === "jpg" && exportBg === "transparent") setExportBg("white");
            }}
            exportBg={exportBg}
            onExportBg={setExportBg}
            videoResolution={videoResolution}
            onVideoResolution={setVideoResolution}
            videoQuality={videoQuality}
            onVideoQuality={setVideoQuality}
            videoDuration={videoDuration}
            onVideoDuration={setVideoDuration}
            videoFps={videoFps}
            onVideoFps={setVideoFps}
            videoBg={videoBg}
            onVideoBg={setVideoBg}
            exportSelected={selected}
            exportCapturing={exportCapturing}
            onCaptureExport={onCaptureExport}
            onWalkExportParent={onWalkExportParent}
            tweakBridge={tweakBridge}
            onAskTweaks={() => {
              // Build the AI prompt that asks Claude to add live-tweak
              // controls to the current page. The host (this editor) wires
              // everything in once the page posts __edit_mode_available, so
              // the prompt only needs to instruct on:
              //   1. the EDITMODE-BEGIN/END marker block (so source rewrites
              //      can find + patch the JSON)
              //   2. the existing tweaks-panel.jsx in the project
              //   3. wiring TWEAK_DEFAULTS keys into the rendered output
              // The dialog lets the user edit before sending.
              const prompt = [
                `For the active page \`${activeTab.route}\` in this sandbox project,`,
                `add live-tweak controls so I can adjust the salient values (text, colors,`,
                `font sizes, spacing, etc.) without touching code.`,
                ``,
                `**How it works in this project:**`,
                `- The page is plain HTML + CDN React + Babel-Standalone (no build step).`,
                `- There is already a \`tweaks-panel.jsx\` at the project root that exports`,
                `  \`useTweaks(DEFAULTS, "storageKey")\` and \`<TweaksPanel>\`. Use them — don't`,
                `  re-implement.`,
                `- Define \`const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{...}/*EDITMODE-END*/;\``,
                `  inside the page (or a small companion .jsx). The marker comments are`,
                `  load-bearing — the editor's host bridge reads them to write knob changes`,
                `  back to source. The block must be valid JSON, exactly one per file.`,
                `- Wire the values from \`useTweaks\` into the rendered output, and render`,
                `  \`<TweaksPanel>\` with \`<TweakText>\`/\`<TweakSelect>\`/\`<TweakSlider>\`/`,
                `  \`<TweakToggle>\` children for each key.`,
                ``,
                `**Scope:**`,
                `- Only edit files inside this project directory.`,
                `- Pick 5–10 high-leverage knobs — don't try to expose every value.`,
                `- Keep the panel small (floating bottom-right is the established pattern).`,
                ``,
                `When done, the editor's "Edit live" toolbar toggle will appear and clicking`,
                `it will open your panel. Each knob change writes back to source automatically.`,
              ].join("\n");
              setTweaksPreviewPrompt(prompt);
            }}
            overrideCount={overrideCountForActive}
            onReset={async () => {
              await clearRouteEverywhere(activeTab.route);
              canvasFrameRef.current?.reloadFrame();
            }}
            onSaveInspectorEdits={saveInspectorEdits}
            onBakeToSource={async () => {
              // Slow path: ask Claude to walk the source and rewrite the
              // original JSX / CSS so the overrides become permanent (i.e.
              // can be deleted from _inspector_edits.css). Use sparingly —
              // this is what you'd hit before shipping a design.
              const overrides = readRoute(activeTab.route);
              const entries = Object.entries(overrides);
              if (entries.length === 0) {
                toast.info("Nothing to bake — your inspector edits are already in source.");
                return;
              }
              // Enrich each override with semantic info pulled from the live
              // iframe so Claude has something to grep for. The selector
              // alone (especially `[data-dm-ref="…"]`) carries nothing
              // source-side.
              const doc = iframeRef.current?.contentDocument;
              const summary = entries
                .map(([sel, props]) => {
                  const propsBlock = Object.entries(props).map(([k, v]) => `    ${k}: ${v};`).join("\n");
                  const el = doc ? (doc.querySelector(sel) as HTMLElement | null) : null;
                  if (!el) {
                    return `  selector: \`${sel}\`\n${propsBlock}`;
                  }
                  const tag = el.tagName.toLowerCase();
                  const cls = (typeof el.className === "string" ? el.className : "")
                    .split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
                  const inner = (el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
                  const parent = el.parentElement;
                  const parentTag = parent ? parent.tagName.toLowerCase() : "";
                  const parentCls = parent && typeof parent.className === "string"
                    ? parent.className.split(/\s+/).filter(Boolean).slice(0, 4).join(" ")
                    : "";
                  const lines = [
                    `  selector: \`${sel}\``,
                    `  tag: <${tag}>${cls ? ` class="${cls}"` : ""}`,
                  ];
                  if (inner) lines.push(`  text: ${JSON.stringify(inner)}`);
                  if (parentTag) lines.push(`  parent: <${parentTag}>${parentCls ? ` class="${parentCls}"` : ""}`);
                  lines.push(propsBlock);
                  return lines.join("\n");
                })
                .join("\n\n");
              setChatTabSwitchKey((k) => k + 1);
              await runTurn({
                text:
                  `Bake the following editor-overrides into the source for route \`${activeTab.route}\`. ` +
                  `For each item, find the element in the corresponding JSX or CSS module by its tag + ` +
                  `class names + inner text + parent context (the positional CSS selector is a fallback ` +
                  `only — don't grep for it). Apply each style permanently in source, then confirm with ` +
                  `one short sentence so I can clear the overrides.\n\n` +
                  `Touch only files inside this sandbox project. Don't run shell commands.\n\n` +
                  `**Overrides to persist:**\n\n` + summary,
                attachments: [],
                target: null,
              });
              // Clear BOTH localStorage and _inspector_edits.css. Without
              // the CSS-file clear, the !important rules would continue to
              // shadow whatever Claude just wrote into source.
              await clearRouteEverywhere(activeTab.route);
              canvasFrameRef.current?.reloadFrame();
            }}
          />}
          <div className={s.rightBody}>
        {isDesignFiles ? (
          <FileBrowserView
            projectId={activeProject.id}
            onOpenRoute={openRouteAsTab}
            openRoutes={openRoutes}
            activeRoute={activeRoute}
            revealRequest={revealRequest}
          />
        ) : (<>
        <div
          className={`${s.canvas} ${activeTab.display === "fill" ? s.canvasFill : s.canvasFrame} ${lastIsPending ? s.canvasBusy : ""}`}
          style={{ position: "relative" }}
        >
          {lastIsPending && (
            <div
              className={s.busyPill}
              role="status"
              aria-live="polite"
              title="An AI run is editing this canvas. Open another chat carefully."
            >
              <span className={s.busyDot} aria-hidden />
              {busyPhrase || "AI working"}
            </div>
          )}
          <CanvasFrame
            ref={canvasFrameRef}
            tab={activeTab}
            projectId={activeProject.id}
            mode={mode}
            zoom={zoom}
            selected={selected}
            commentTarget={commentTarget}
            onSelect={(sel, extend) => {
              if (sel) {
                setSelected(sel);
                setSelectionList((prev) => {
                  if (!extend) return [sel.selector];
                  if (prev.includes(sel.selector)) return prev.filter((s) => s !== sel.selector);
                  return [...prev, sel.selector];
                });
              } else {
                setSelected(null);
                setSelectionList([]);
              }
            }}
            onComment={setCommentTarget}
            iframeRef={iframeRef}
          />
          <CommentPins
            projectId={activeProject.id}
            file={activeTab.route}
            zoom={zoom}
            scaleByZoom={activeTab.display === "frame"}
            selectedId={selectedPinId}
            onSelect={setSelectedPinId}
            iframeRef={iframeRef}
          />
          {mode === "draw" && (
            <Suspense fallback={null}>
              <DrawOverlay
                route={activeTab.route}
                active={true}
                iframeRef={iframeRef}
                zoom={zoom}
                scaleByZoom={activeTab.display === "frame"}
                color={drawColor}
                width={3}
              />
            </Suspense>
          )}
          {mode === "draw" && (
            <Suspense fallback={null}>
            <DrawActionBar
              route={activeTab.route}
              strokeCount={routeStrokes.length}
              color={drawColor}
              onColorChange={setDrawColor}
              onLeaveDrawMode={() => setMode("select")}
              onSend={async (text) => {
                const ifr = iframeRef.current;
                if (!ifr) return;
                // Capture at 1× so coordinates line up with the strokes
                // (which are stored in iframe-local px). Compositing with
                // mismatched scales would shift the strokes off-target.
                const base = await captureIframeAsDataUrl(ifr, { scale: 1 });
                const composite = await compositeStrokesOnto(base, routeStrokes);
                await runTurn({
                  text: text || "(see drawing on the page)",
                  attachments: [],
                  target: null,
                  screenshotOverride: composite,
                  thumbnailOverride: composite,
                });
              }}
            />
            </Suspense>
          )}
          {commentTarget && (
            <CommentBubble
              target={commentTarget}
              onCancel={() => setCommentTarget(null)}
              onSubmit={(text, opts) => {
                // Save-and-send: persist the comment AND queue it as a
                // chat turn (the comment becomes the user's next chat
                // message; the element snapshot rides along as a chat
                // attachment). Plain save: just persist the pin; the
                // user can later promote via the Comments panel.
                const target = commentTarget;
                setCommentTarget(null);
                const ifr = iframeRef.current;
                const viewport = ifr?.contentWindow
                  ? { w: ifr.contentWindow.innerWidth, h: ifr.contentWindow.innerHeight }
                  : undefined;
                const c = addComment(activeProject.id, {
                  file: activeTab.route,
                  selector: target.selector,
                  tag: target.tag,
                  innerText: target.innerText,
                  // Persist the rich profile + kind we resolved at click
                  // time so the comments panel stays smart across reloads.
                  descriptor: target.descriptor,
                  kind: target.kind,
                  body: text,
                  x: target.localX,
                  y: target.localY,
                  viewport,
                });
                trackEvent("comment_save", { route: activeTab.route, mode: opts.mode }, activeProject.id);
                setChatTabSwitchKey((k) => k + 1);
                setSelectedPinId(c.id);
                captureDomSnapshot(iframeRef.current, target.selector).then((snap) => {
                  if (!snap) return;
                  updateComment(activeProject.id, c.id, {
                    thumbnail: snap.thumbnail,
                    domHtml: snap.html,
                    styles: snap.styles,
                    scrollX: snap.scrollX,
                    scrollY: snap.scrollY,
                  });
                });
                if (opts.mode === "save-and-send") {
                  // Fire the chat turn immediately. We capture the
                  // element fresh here (best-effort) so the chat bubble
                  // shows what the user pointed at — same path the
                  // multi-comment promote flow uses, but for a single
                  // comment with no UI bouncing.
                  void (async () => {
                    const chatAttachments: Attachment[] = [...opts.attachments];
                    try {
                      // captureIframeAsDataUrl takes the iframe + an opts
                      // object with `selector` (calls querySelector inside
                      // the iframe doc). captureElementAsDataUrl is for an
                      // already-resolved HTMLElement. The previous shape
                      // here was wrong.
                      if (iframeRef.current) {
                        const dataUrl = await captureIframeAsDataUrl(
                          iframeRef.current,
                          { selector: target.selector, scale: 1 },
                        );
                        if (dataUrl) chatAttachments.unshift({ dataUrl, name: `comment-${c.id}.png` });
                      }
                    } catch { /* best-effort */ }
                    // Pass the skill preamble for the comment-promote path
                    // the same way the Composer does on a normal send.
                    // Skills are persisted to localStorage on every toggle,
                    // so reading at send time always reflects the current set.
                    const skillsPreamble = buildSkillsPreamble(
                      loadActiveSkills(activeProject.id),
                    );
                    queueOrSend(
                      text,
                      chatAttachments,
                      opts.modelId,
                      skillsPreamble ? { skillsPreamble } : undefined,
                    );
                  })();
                }
              }}
            />
          )}
        </div>

        {mode === "edit" && (
          <Suspense fallback={null}>
          <Inspector
            selected={selected}
            selectionCount={selectionList.length}
            doc={iframeRef.current?.contentDocument ?? null}
            onSelectSimilar={() => {
              if (!selected) return;
              const doc = getActiveDoc();
              if (!doc) return;
              const primary = resolveCssPath(doc, selected.selector) as HTMLElement | null;
              if (!primary) return;
              const tag = primary.tagName;
              const cls = (typeof primary.className === "string" ? primary.className : "")
                .split(/\s+/).filter(Boolean)[0];
              const candidates = doc.querySelectorAll(cls ? `${tag.toLowerCase()}.${cls}` : tag.toLowerCase());
              const sels: string[] = [];
              candidates.forEach((c) => sels.push(cssPath(c)));
              setSelectionList(sels);
            }}
            onChange={(prop, value) => applyToSelection(prop, value)}
            onApplyColor={(color) => applyToSelection("color", color)}
            onApplyFont={(family) => applyToSelection("font-family", family)}
            onSetPositionMode={(mode) => {
              // Smart position flip: tells the inject-script to switch
              // `position` AND auto-compute left/top so the element stays
              // visually put. Without that, switching to absolute snaps
              // it to (0,0). After the bus mutation lands, mirror the
              // resulting inline values into the override store so a
              // reload keeps the new layout.
              if (!selected) return;
              const doc = iframeRef.current?.contentDocument;
              if (!doc) return;
              const el = resolveCssPath(doc, selected.selector) as HTMLElement | null;
              if (!el) return;
              let ref = el.getAttribute("data-dm-ref");
              if (!ref) {
                ref = String(hostStampCounter.current++);
                el.setAttribute("data-dm-ref", ref);
              }
              const dm = dmRef.current;
              dm?.send({ type: "setPositionMode", ref, mode });
              // The inject-script writes left/top synchronously via
              // postMessage receive — but postMessage is async, so read
              // back on the next microtask to capture computed values.
              requestAnimationFrame(() => {
                setOverride(activeTab.route, selected.selector, "position", mode);
                if (mode === "static") {
                  setOverride(activeTab.route, selected.selector, "left", "");
                  setOverride(activeTab.route, selected.selector, "top", "");
                } else {
                  setOverride(activeTab.route, selected.selector, "left", el.style.left || "");
                  setOverride(activeTab.route, selected.selector, "top", el.style.top || "");
                }
                // Re-emit selection so inspector inputs (top/left) refresh
                // — without this they keep showing the pre-flip computed
                // values until the user re-clicks.
                setSelected({
                  selector: selected.selector,
                  tag: selected.tag,
                  computed: doc.defaultView!.getComputedStyle(el),
                  descriptor: buildDescriptor(el),
                });
              });
            }}
            onAskKimi={async (text, modelId) => {
              if (!selected) return;
              const doc = iframeRef.current?.contentDocument ?? null;
              const el = doc ? (resolveCssPath(doc, selected.selector) as HTMLElement | null) : null;
              const askDescriptor = selected.descriptor ?? (el ? buildDescriptor(el) : undefined);
              const askKind = askDescriptor
                ? classifyKind({
                    descriptor: askDescriptor,
                    computed: computedHints(selected.computed, el ?? undefined),
                  })
                : undefined;
              const target: CommentTarget = {
                x: 0, y: 0, localX: 0, localY: 0,
                selector: selected.selector,
                tag: selected.tag,
                innerText: el?.innerText?.slice(0, 280),
                outerHtml: el?.outerHTML?.slice(0, 1500),
                descriptor: askDescriptor,
                kind: askKind,
              };
              setChatTabSwitchKey((k) => k + 1);
              await runTurn({ text, attachments: [], target, modelId });
            }}
            onClose={() => {
              setMode("select");
              setSelected(null);
              setSelectionList([]);
            }}
          />
          </Suspense>
        )}
        </>)}
          </div>
        </div>

      </div>

      {assetsOpen && (
        <Suspense fallback={null}>
          <AssetsDialog
            open={assetsOpen}
            onClose={() => setAssetsOpen(false)}
          />
        </Suspense>
      )}

      {tweaksPreviewPrompt !== null && (
        <Suspense fallback={null}>
          <TweaksPreviewDialog
            open={tweaksPreviewPrompt !== null}
            initialPrompt={tweaksPreviewPrompt ?? ""}
            onClose={() => setTweaksPreviewPrompt(null)}
            onConfirm={async (prompt) => {
              setTweaksPreviewPrompt(null);
              setChatTabSwitchKey((k) => k + 1);
              await runTurn({ text: prompt, attachments: [], target: null });
            }}
          />
        </Suspense>
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onClose={() => {
              setSettingsOpen(false);
              // Reset to the default section on close so the next plain
              // open lands on Theme, not whatever was last visited via
              // openSkillsSettings.
              setSettingsSection("theme");
            }}
            initialSection={settingsSection}
            projectId={activeProject?.id}
          />
        </Suspense>
      )}

      {templatesOpen && (
        <Suspense fallback={null}>
          <TemplatesDialog
            open={templatesOpen}
            onClose={() => setTemplatesOpen(false)}
            onPick={(t) => {
              setTemplatesOpen(false);
              const existing = tabs.find((tab) => tab.route === t.route);
              if (existing) { setActiveTabId(existing.id); return; }
              const tab: Tab = {
                id: uniqueTabId(),
                label: routeToLabel(t.route),
                route: t.route,
                display: defaultDisplay(t.route),
              };
              setTabs((prev) => [...prev, tab]);
              setActiveTabId(tab.id);
              trackEvent("tab_open", { route: t.route, source: "templates" }, activeProject.id);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/* ─── Tab bar ────────────────────────────────────────────────── */
function TabBar({
  projectTitle,
  onRenameProject,
  tabs,
  activeId,
  onActivate,
  onReveal,
  onClose,
  onSetPinned,
  onRename,
  onAdd,
  onOpenSettings,
  dirtyRoutes,
  onReorder,
  onCloseMany,
}: {
  projectTitle: string;
  onRenameProject: (next: string) => void;
  tabs: Tab[];
  activeId: string;
  onActivate: (id: string) => void;
  onReveal: (route: string) => void;
  onClose: (id: string) => void;
  onSetPinned: (id: string, pinned: boolean) => void;
  onRename: (id: string, label: string) => void;
  onAdd: () => void;
  onOpenSettings: () => void;
  /** Routes that currently have inspector overrides — drives the dirty
   *  mark on tabs whose route is in the set. */
  dirtyRoutes: Set<string>;
  /** Move `fromId` to land immediately before `toId`. */
  onReorder: (fromId: string, toId: string) => void;
  /** Bulk close — used by the IDE-style context-menu items. */
  onCloseMany: (predicate: (t: Tab) => boolean) => void;
}) {
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Vertical wheel → horizontal scroll on the tabbar so an overflowed tab
  // strip stays reachable on a trackpad/mouse without forcing the user to
  // shift-scroll. Native horizontal wheel deltas (Magic Mouse, trackpads)
  // pass through unchanged. Bound non-passive because we call
  // preventDefault to keep the page from also scrolling vertically.
  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollBy({ left: e.deltaY, behavior: "auto" });
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className={s.tabbar} ref={tabbarRef}>
      <ProjectTitle value={projectTitle} onChange={onRenameProject} />
      <div
        className={`${s.tab} ${activeId === DESIGN_FILES_TAB_ID ? s.active : ""}`}
        onClick={() => onActivate(DESIGN_FILES_TAB_ID)}
        title="Project files"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4 H6 L7.5 6 H14 V13 H2 Z" />
        </svg>
        <span className={s.label}>Design Files</span>
      </div>
      {tabs.map((t) => (
        <TabCell
          key={t.id}
          tab={t}
          active={t.id === activeId}
          dirty={dirtyRoutes.has(t.route)}
          dragging={draggingId === t.id}
          onActivate={() => onActivate(t.id)}
          onReveal={() => onReveal(t.route)}
          onClose={() => onClose(t.id)}
          onUnpin={() => onSetPinned(t.id, false)}
          onRenameSubmit={(label) => onRename(t.id, label)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ tab: t, x: e.clientX, y: e.clientY });
          }}
          onDragStart={() => setDraggingId(t.id)}
          onDragEnd={() => setDraggingId(null)}
          onDropOn={(fromId) => onReorder(fromId, t.id)}
        />
      ))}
      {menu && (
        <TabContextMenu
          tab={menu.tab}
          tabs={tabs}
          x={menu.x}
          y={menu.y}
          onPinToggle={() => { onSetPinned(menu.tab.id, !menu.tab.pinned); setMenu(null); }}
          onCloseTab={() => { onClose(menu.tab.id); setMenu(null); }}
          onReveal={() => { onReveal(menu.tab.route); setMenu(null); }}
          onCloseOthers={() => { onCloseMany((x) => x.id !== menu.tab.id); setMenu(null); }}
          onCloseToRight={() => {
            const idx = tabs.findIndex((x) => x.id === menu.tab.id);
            if (idx >= 0) onCloseMany((x) => tabs.indexOf(x) > idx);
            setMenu(null);
          }}
          onCloseAll={() => { onCloseMany(() => true); setMenu(null); }}
          onCopyPath={() => {
            try { void navigator.clipboard.writeText(menu.tab.route); } catch { /* ignore */ }
            setMenu(null);
          }}
          onDismiss={() => setMenu(null)}
        />
      )}
      <button className={s.tabPlus} onClick={onAdd} aria-label="New tab">+</button>

      <div className={s.tabRight}>
        <button
          type="button"
          className={s.settingsBtn}
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Open settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <Link to="/projects" className={s.present} title="Back to projects" aria-label="Back to projects">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="2" width="4" height="4" rx="0.6" />
            <rect x="8" y="2" width="4" height="4" rx="0.6" />
            <rect x="2" y="8" width="4" height="4" rx="0.6" />
            <rect x="8" y="8" width="4" height="4" rx="0.6" />
          </svg>
          Projects
        </Link>
      </div>
    </div>
  );
}

/* ─── Tab cell ───────────────────────────────────────────────── *
 * One tab in the bar. Owns its own rename-mode state so the input can
 * commit on blur/Enter without re-rendering the whole tabbar. Pinned
 * tabs render a pin glyph in place of the close × — clicking it unpins
 * (close still reachable via right-click). */
function TabCell({
  tab,
  active,
  dirty,
  dragging,
  onActivate,
  onReveal,
  onClose,
  onUnpin,
  onRenameSubmit,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  tab: Tab;
  active: boolean;
  /** Inspector overrides exist for this tab's route — surface a small
   *  bullet so the user knows there's unsaved work on a non-active tab. */
  dirty: boolean;
  /** This tab is the source of an in-flight drag. Drives data-dragging
   *  so CSS can dim the source cell while it's traveling. */
  dragging: boolean;
  onActivate: () => void;
  onReveal: () => void;
  onClose: () => void;
  onUnpin: () => void;
  onRenameSubmit: (label: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Drop-target callback: another tab landed on this cell — caller
   *  reorders so `fromId` lands immediately before `tab.id`. */
  onDropOn: (fromId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tab.label);
  const [dropTarget, setDropTarget] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);

  const commit = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== tab.label) onRenameSubmit(next);
  };

  const kind = useMemo(() => tabKind(tab.route), [tab.route]);

  return (
    <div
      className={`${s.tab} ${active ? s.active : ""} ${tab.pinned ? s.tabPinned : ""}`}
      data-dragging={dragging || undefined}
      data-drop-target={dropTarget || undefined}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", tab.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={() => { setDropTarget(false); onDragEnd(); }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/plain")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dropTarget) setDropTarget(true);
        }
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropTarget(false);
        const fromId = e.dataTransfer.getData("text/plain");
        if (fromId && fromId !== tab.id) onDropOn(fromId);
      }}
      onClick={(e) => {
        if (renaming) return;
        if (e.metaKey || e.ctrlKey) { onReveal(); return; }
        onActivate();
      }}
      onContextMenu={onContextMenu}
      title={renaming ? "" : "Click to focus · Cmd-click to reveal in Design Files · Drag to reorder · Double-click to rename"}
    >
      {tab.pinned && <span className={s.tabPin} aria-hidden>📌</span>}
      <span className={s.tabKind} aria-hidden>
        <TabKindIcon kind={kind} />
      </span>
      {renaming ? (
        <input
          ref={inputRef}
          className={s.tabRenameInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); setDraft(tab.label); setRenaming(false); }
          }}
          onClick={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      ) : (
        <span
          className={s.label}
          onDoubleClick={(e) => { e.stopPropagation(); setDraft(tab.label); setRenaming(true); }}
        >
          {tab.label}
          {dirty && <span className={s.tabDirty} aria-label="Unsaved overrides">•</span>}
        </span>
      )}
      {tab.pinned ? (
        <button
          className={s.x}
          onClick={(e) => { e.stopPropagation(); onUnpin(); }}
          aria-label="Unpin tab"
          title="Unpin"
        >∘</button>
      ) : (
        <button
          className={s.x}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close tab"
        >×</button>
      )}
    </div>
  );
}

function TabContextMenu({
  tab,
  tabs,
  x,
  y,
  onPinToggle,
  onCloseTab,
  onReveal,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onCopyPath,
  onDismiss,
}: {
  tab: Tab;
  /** Whole-strip context — used to disable close-to-right when this is
   *  the rightmost tab, and close-others when it's the only tab. */
  tabs: Tab[];
  x: number;
  y: number;
  onPinToggle: () => void;
  onCloseTab: () => void;
  onReveal: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onCloseAll: () => void;
  onCopyPath: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    const onClick = () => onDismiss();
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => window.addEventListener("mousedown", onClick), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onDismiss]);

  const idx = tabs.findIndex((x) => x.id === tab.id);
  const hasOthers = tabs.length > 1;
  const hasRight = idx >= 0 && idx < tabs.length - 1;

  return (
    <div
      className={s.tabMenu}
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      <button className={s.tabMenuItem} onClick={onPinToggle}>
        {tab.pinned ? "Unpin tab" : "Pin tab"}
      </button>
      <button className={s.tabMenuItem} onClick={onReveal}>Reveal in Design Files</button>
      <button className={s.tabMenuItem} onClick={onCopyPath}>Copy path</button>
      <div className={s.tabMenuSep} role="separator" />
      <button className={s.tabMenuItem} onClick={onCloseTab}>Close tab</button>
      <button className={s.tabMenuItem} onClick={onCloseOthers} disabled={!hasOthers}>
        Close others
      </button>
      <button className={s.tabMenuItem} onClick={onCloseToRight} disabled={!hasRight}>
        Close tabs to the right
      </button>
      <button className={`${s.tabMenuItem} ${s.tabMenuItemDanger}`} onClick={onCloseAll}>
        Close all
      </button>
    </div>
  );
}

/* ─── Toolbar ────────────────────────────────────────────────── */
/** Split button for unsaved inspector overrides. Main click → instant
 *  CSS-file save (no AI). Chevron → menu with "Bake to source" (AI). */
function InspectorSaveButton({
  count,
  onSave,
  onBake,
}: {
  count: number;
  onSave: () => void;
  onBake: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onAway = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onAway);
    return () => window.removeEventListener("mousedown", onAway);
  }, [open]);
  return (
    <span ref={wrapRef} className={s.inspectorSplit}>
      <button
        className={s.inspectorSavePrimary}
        onClick={onSave}
        title={`Write ${count} inspector edit${count === 1 ? "" : "s"} to _inspector_edits.css (no AI)`}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8 L7 12 L13 4" />
        </svg>
        Save {count}
      </button>
      <button
        className={s.inspectorSaveChevron}
        onClick={() => setOpen((v) => !v)}
        title="Other save options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ▾
      </button>
      {open && (
        <div className={s.inspectorSaveMenu} role="menu">
          <button
            role="menuitem"
            className={s.inspectorSaveMenuItem}
            onClick={() => { setOpen(false); onBake(); }}
          >
            <strong>Bake to source ↗</strong>
            <span>AI rewrites the original JSX/CSS so the change is permanent. Slower.</span>
          </button>
        </div>
      )}
    </span>
  );
}

function Toolbar({
  mode,
  onMode,
  zoom,
  onZoom,
  showZoom,
  display,
  onDisplay,
  viewport,
  onViewport,
  onAskTweaks,
  tweakBridge,
  overrideCount,
  onSaveInspectorEdits,
  onBakeToSource,
  onReset,
  onClearStrokes,
  exportScale,
  onExportScale,
  exportFormat,
  onExportFormat,
  exportBg,
  onExportBg,
  videoResolution,
  onVideoResolution,
  videoQuality,
  onVideoQuality,
  videoDuration,
  onVideoDuration,
  videoFps,
  onVideoFps,
  videoBg,
  onVideoBg,
  exportSelected,
  exportCapturing,
  onCaptureExport,
  onWalkExportParent,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  zoom: number;
  onZoom: (z: number) => void;
  showZoom: boolean;
  display: DisplayMode;
  onDisplay: (d: DisplayMode) => void;
  viewport: Viewport;
  onViewport: (vp: Viewport) => void;
  onAskTweaks: () => void;
  exportScale: number;
  onExportScale: (n: number) => void;
  exportFormat: ExportFormat;
  onExportFormat: (f: ExportFormat) => void;
  exportBg: "transparent" | "white";
  onExportBg: (b: "transparent" | "white") => void;
  /** Video sub-options — only relevant when exportFormat === "video". */
  videoResolution: "1080p" | "1440p" | "4K" | "8K";
  onVideoResolution: (r: "1080p" | "1440p" | "4K" | "8K") => void;
  videoQuality: "draft" | "standard" | "high" | "master";
  onVideoQuality: (q: "draft" | "standard" | "high" | "master") => void;
  videoDuration: number | "auto";
  onVideoDuration: (s: number | "auto") => void;
  videoFps: 24 | 30 | 60;
  onVideoFps: (n: 24 | 30 | 60) => void;
  videoBg: "transparent" | "black" | "white";
  onVideoBg: (b: "transparent" | "black" | "white") => void;
  /** Currently-selected element on the canvas — what the Capture button
   *  will export. null = "click an element to select" prompt. */
  exportSelected: SelectedInfo | null;
  /** True while the actual capture is running so the button can show
   *  "Capturing…" instead of "Capture". */
  exportCapturing: boolean;
  onCaptureExport: () => void;
  /** Walks the export selection up to its parentElement — fixes the
   *  common "click hit a nested span/img inside the card I wanted". */
  onWalkExportParent: () => void;
  /** Live-tweak bridge — when `available` is true, the iframe page has
   *  EDITMODE markers + a TweaksPanel that responds to postMessage.
   *  Toggling sends __activate/__deactivate to it; edits flow back via
   *  __edit_mode_set_keys → /api/projects/:id/tweak. */
  tweakBridge: import("../lib/tweakBridge").TweakBridge;
  /** Number of unsaved inspector overrides for the active route. When
   *  > 0 the "Save N edits" button is shown; the chevron menu next to
   *  it exposes "Bake to source" (the AI-driven path). */
  overrideCount: number;
  /** Instant — writes to _inspector_edits.css, no AI involved. */
  onSaveInspectorEdits: () => void;
  /** AI-driven — patches the original JSX / CSS source for permanence. */
  onBakeToSource: () => void;
  /** Discards inspector edits for this route — clears localStorage AND
   *  removes the rules from _inspector_edits.css on disk. Bound to the
   *  X button in the toolbar. */
  onReset: () => void;
  onClearStrokes: () => void;
}) {
  const [vpOpen, setVpOpen] = useState(false);
  const [exportPickerOpen, setExportPickerOpen] = useState(false);
  const exportPickerRef = useRef<HTMLDivElement>(null);
  // Picker visibility tracks export mode: open on entry, drop on exit.
  useEffect(() => {
    setExportPickerOpen(mode === "export");
  }, [mode]);
  // Click-outside + Escape dismiss the picker without leaving export mode.
  useEffect(() => {
    if (!exportPickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!exportPickerRef.current) return;
      if (!exportPickerRef.current.contains(e.target as Node)) setExportPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportPickerOpen(false);
    };
    // Defer one tick so the click that opened the picker doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportPickerOpen]);
  return (
    <div className={s.toolbar}>
      <button
        className={s.iconBtn}
        aria-pressed={mode === "edit"}
        onClick={() => onMode(mode === "edit" ? "select" : "edit")}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <path d="M11 2 L14 5 L5 14 L2 14 L2 11 Z" />
          <path d="M9 4 L12 7" />
        </svg>
        Edit
      </button>
      <button
        className={s.iconBtn}
        aria-pressed={mode === "comment"}
        onClick={() => onMode(mode === "comment" ? "select" : "comment")}
        title="Coming soon"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
          <path d="M2 3 H14 V11 H7 L4 14 V11 H2 Z" />
        </svg>
        Comment
      </button>
      <div className={s.exportPicker} ref={exportPickerRef}>
        <button
          className={s.iconBtn}
          aria-pressed={mode === "export"}
          onClick={() => {
            // 3-state ladder so the picker is dismissable without leaving
            // export mode: out → in+picker → in+no-picker → out.
            if (mode !== "export") onMode("export");
            else if (!exportPickerOpen) setExportPickerOpen(true);
            else onMode("select");
          }}
          title="Click any element to export — settings below"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2 V10" />
            <path d="M5 7 L8 10 L11 7" />
            <path d="M3 12 V13 H13 V12" />
          </svg>
          Export
        </button>
        {mode === "export" && exportPickerOpen && (
          <div className={s.exportMenu}>
            <button
              className={s.exportClose}
              onClick={() => setExportPickerOpen(false)}
              aria-label="Close export options"
              title="Close (Esc) — stays in export mode"
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <path d="M3 3 L9 9 M3 9 L9 3" />
              </svg>
            </button>
            <div className={s.exportRow}>
              <span className={s.exportLabel}>Format</span>
              <div className={s.exportSegmented}>
                <button className={s.exportSegBtn} aria-pressed={exportFormat === "png"} onClick={() => onExportFormat("png")}>PNG</button>
                <button className={s.exportSegBtn} aria-pressed={exportFormat === "jpg"} onClick={() => onExportFormat("jpg")}>JPG</button>
                <button
                  className={s.exportSegBtn}
                  aria-pressed={exportFormat === "ograf"}
                  onClick={() => onExportFormat("ograf")}
                  title="DaVinci Resolve 21+ HTML graphics bundle (.ograf.zip)"
                >
                  OGraf
                </button>
                <button
                  className={s.exportSegBtn}
                  aria-pressed={exportFormat === "lottie"}
                  onClick={() => onExportFormat("lottie")}
                  title="Lottie source passthrough (.json / .lottie). Native in Resolve 21+ Media Pool."
                >
                  Lottie
                </button>
                <button
                  className={s.exportSegBtn}
                  aria-pressed={exportFormat === "video"}
                  onClick={() => onExportFormat("video")}
                  title="Video — MP4 (luma-keyable) or ProRes 4444 (with alpha)"
                >
                  Video
                </button>
              </div>
            </div>
            {(exportFormat === "png" || exportFormat === "jpg") && (
              <div className={s.exportRow}>
                <span className={s.exportLabel}>Scale</span>
                <div className={s.exportSegmented}>
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      className={s.exportSegBtn}
                      aria-pressed={exportScale === n}
                      onClick={() => onExportScale(n)}
                    >
                      {n}×
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(exportFormat === "png" || exportFormat === "jpg") && (
              <div className={s.exportRow}>
                <span className={s.exportLabel}>Background</span>
                <div className={s.exportSegmented}>
                  <button
                    className={s.exportSegBtn}
                    aria-pressed={exportBg === "transparent"}
                    disabled={exportFormat === "jpg"}
                    onClick={() => onExportBg("transparent")}
                    title={exportFormat === "jpg" ? "JPG can't carry transparency" : undefined}
                  >
                    Transparent
                  </button>
                  <button className={s.exportSegBtn} aria-pressed={exportBg === "white"} onClick={() => onExportBg("white")}>White</button>
                </div>
              </div>
            )}
            {/* Video sub-options. Resolution drives deviceScaleFactor —
                vector / text content stays sharp at 4K because the
                browser re-rasterizes at higher DPI. Transparent bg uses
                ProRes 4444; black/white use H.264 (luma-key the black
                in Resolve via Composite Mode = Add). */}
            {exportFormat === "video" && (
              <>
                <div className={s.exportRow}>
                  <span className={s.exportLabel}>Resolution</span>
                  <div className={s.exportSegmented}>
                    {(["1080p", "1440p", "4K", "8K"] as const).map((r) => (
                      <button key={r} className={s.exportSegBtn} aria-pressed={videoResolution === r} onClick={() => onVideoResolution(r)}>{r}</button>
                    ))}
                  </div>
                </div>
                <div className={s.exportRow}>
                  <span className={s.exportLabel}>Quality</span>
                  <div className={s.exportSegmented}>
                    {(["draft", "standard", "high", "master"] as const).map((q) => (
                      <button key={q} className={s.exportSegBtn} aria-pressed={videoQuality === q} onClick={() => onVideoQuality(q)}>{q[0].toUpperCase() + q.slice(1)}</button>
                    ))}
                  </div>
                </div>
                <div className={s.exportRow}>
                  <span className={s.exportLabel}>Duration</span>
                  <div className={s.exportSegmented}>
                    <button
                      className={s.exportSegBtn}
                      aria-pressed={videoDuration === "auto"}
                      onClick={() => onVideoDuration("auto")}
                      title="Match the animation's natural length (CSS animation-duration / Lottie totalFrames). Falls back to 5s for rAF-only animations."
                    >
                      Auto
                    </button>
                    {[3, 5, 10, 15].map((d) => (
                      <button key={d} className={s.exportSegBtn} aria-pressed={videoDuration === d} onClick={() => onVideoDuration(d)}>{d}s</button>
                    ))}
                  </div>
                </div>
                <div className={s.exportRow}>
                  <span className={s.exportLabel}>FPS</span>
                  <div className={s.exportSegmented}>
                    {([24, 30, 60] as const).map((f) => (
                      <button key={f} className={s.exportSegBtn} aria-pressed={videoFps === f} onClick={() => onVideoFps(f)}>{f}</button>
                    ))}
                  </div>
                </div>
                <div className={s.exportRow}>
                  <span className={s.exportLabel}>Background</span>
                  <div className={s.exportSegmented}>
                    <button
                      className={s.exportSegBtn}
                      aria-pressed={videoBg === "transparent"}
                      onClick={() => onVideoBg("transparent")}
                      title="ProRes 4444 .mov with real alpha — biggest file, easiest in any NLE"
                    >
                      Transparent
                    </button>
                    <button
                      className={s.exportSegBtn}
                      aria-pressed={videoBg === "black"}
                      onClick={() => onVideoBg("black")}
                      title="H.264 .mp4 — small file. In Resolve set Composite Mode → Add to luma-key the black bg out"
                    >
                      Black
                    </button>
                    <button className={s.exportSegBtn} aria-pressed={videoBg === "white"} onClick={() => onVideoBg("white")}>White</button>
                  </div>
                </div>
              </>
            )}
            {exportFormat === "ograf" && (
              <div className={s.exportHint}>
                Bundles HTML, CSS, fonts, and images into an .ograf.zip — drag into the DaVinci Resolve 21+ Media Pool.
              </div>
            )}
            {exportFormat === "lottie" && (
              <div className={s.exportHint}>
                Copies the Lottie source file (.json / .lottie) from the
                selection's &lt;lottie-player&gt;. Native in Resolve 21+ Media Pool.
              </div>
            )}
            {exportFormat === "video" && (
              <div className={s.exportHint}>
                {videoBg === "transparent"
                  ? "ProRes 4444 .mov with real alpha — drop on a video track, transparency just works. "
                  : videoBg === "black"
                  ? "H.264 .mp4 — small file. In Resolve, set Composite Mode → Add to luma-key the black bg out. "
                  : "H.264 .mp4 — opaque. Standard MP4 for any timeline. "}
                Animation runs at its natural speed; FPS only changes smoothness, not playback speed.
              </div>
            )}
            <div className={s.exportRow}>
              <span className={s.exportLabel}>Target</span>
              {exportSelected ? (
                <div className={s.exportTarget}>
                  <div className={s.exportTargetInfo}>
                    <code className={s.exportTargetTag}>&lt;{exportSelected.tag}&gt;</code>
                    <span className={s.exportTargetSel} title={exportSelected.selector}>
                      {exportSelected.selector.length > 40
                        ? "…" + exportSelected.selector.slice(-40)
                        : exportSelected.selector}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={s.exportTargetParent}
                    onClick={onWalkExportParent}
                    title="Select parent element (when the click hit a child)"
                  >
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 9 L6 3" />
                      <path d="M3 6 L6 3 L9 6" />
                    </svg>
                    Parent
                  </button>
                </div>
              ) : (
                <div className={s.exportHint}>Click an element on the canvas to select it.</div>
              )}
            </div>
            <button
              type="button"
              className={s.exportCaptureBtn}
              onClick={onCaptureExport}
              disabled={!exportSelected || exportCapturing}
            >
              {exportCapturing ? "Capturing…" : "Capture"}
            </button>
          </div>
        )}
      </div>
      <button
        className={s.iconBtn}
        aria-pressed={mode === "draw"}
        onClick={() => onMode(mode === "draw" ? "select" : "draw")}
        title="Sketch on top of the iframe (saves per-route)"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 14 L5 13 L13 5 L11 3 L3 11 Z" />
          <path d="M10 4 L12 6" />
        </svg>
        Draw
      </button>
      {mode === "draw" && (
        <button
          className={s.iconBtn}
          onClick={onClearStrokes}
          title="Clear all strokes on this route"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M3 5 H13 M5 5 V13 H11 V5 M7 5 V3 H9 V5" />
          </svg>
          Clear
        </button>
      )}

      <div className={s.toolDivider} aria-hidden="true" />

      <button
        className={s.iconBtn}
        title="Ask AI to add tweak controls for this file"
        onClick={onAskTweaks}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="9" cy="7" r="4" />
          <path d="M3 14 L6 11" strokeLinecap="round" />
          <path d="M7 7 H11 M9 5 V9" strokeLinecap="round" />
        </svg>
        Tweaks
      </button>

      {/* Live-tweak toggle — only appears when the iframe page declared
          __edit_mode_available. Click to show/hide the in-page Tweaks
          panel; edits flow back to disk via the __edit_mode_set_keys
          postMessage → /api/projects/:id/tweak roundtrip. */}
      {tweakBridge.available && (
        <button
          className={s.iconBtn}
          aria-pressed={tweakBridge.editing}
          onClick={() => {
            // Tweak edits land in source via the EDITMODE block; saved
            // inspector edits in _inspector_edits.css use !important and
            // would silently shadow them. Warn before activating so the
            // user can clear inspector edits first.
            if (!tweakBridge.editing && overrideCount > 0) {
              const choice = confirm(
                `This route has ${overrideCount} saved inspector edit${overrideCount === 1 ? "" : "s"} that use !important — they'll shadow tweak changes you make in the live panel.\n\n` +
                `OK = clear inspector edits first, then open the panel.\n` +
                `Cancel = open the panel anyway (tweak edits may not be visible).`,
              );
              if (choice) {
                onReset();
              }
            }
            tweakBridge.toggle();
          }}
          title={tweakBridge.editing
            ? "Hide the in-page Tweaks panel"
            : "Show the in-page Tweaks panel — edits write back to source"}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5 V4 M8 12 V14.5 M1.5 8 H4 M12 8 H14.5 M3.2 3.2 L4.8 4.8 M11.2 11.2 L12.8 12.8 M3.2 12.8 L4.8 11.2 M11.2 4.8 L12.8 3.2" />
          </svg>
          {tweakBridge.editing ? "Tweaking" : "Edit live"}
        </button>
      )}

      {/* Inspector save split-button — only shown when there are
          unsaved overrides on the active route. Main click writes to
          _inspector_edits.css instantly (no AI). Chevron menu exposes
          "Bake to source" (the AI-driven path) for permanence. */}
      {overrideCount > 0 && (
        <InspectorSaveButton
          count={overrideCount}
          onSave={onSaveInspectorEdits}
          onBake={onBakeToSource}
        />
      )}

      <div className={s.toolSpacer} />

      {/* Hide the frame toggle entirely when the iframe is a workshop /
          canvas page — it owns its own viewport (pan/zoom, artboards),
          so wrapping it in a device frame would be canvas-inside-canvas.
          The Editor effect below also force-snaps display back to "fill"
          if a canvas page mounts while frame mode is on. */}
      {!tweakBridge.isCanvas && (
        <button
          className={s.iconBtn}
          title={display === "fill" ? "Switch to framed preview" : "Fit page to canvas"}
          onClick={() => onDisplay(display === "fill" ? "frame" : "fill")}
        >
          {display === "fill" ? (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="3" width="12" height="10" rx="1" />
              <path d="M5 6 L11 6 M5 9 L9 9" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="1" y="2" width="14" height="12" rx="1" />
              <path d="M4 5 L12 5 M4 8 L12 8 M4 11 L8 11" strokeLinecap="round" />
            </svg>
          )}
          {display === "fill" ? "Fill" : "Frame"}
        </button>
      )}

      {!tweakBridge.isCanvas && display === "frame" && (
        <div className={s.viewportPicker}>
          <button
            className={s.iconBtn}
            onClick={() => setVpOpen((o) => !o)}
            title="Viewport size"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="3" width="12" height="9" rx="1" />
              <path d="M5 14 H11" strokeLinecap="round" />
            </svg>
            {viewport.w}×{viewport.h}
          </button>
          {vpOpen && (
            <div className={s.viewportMenu}>
              {VIEWPORT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={s.viewportItem}
                  aria-pressed={viewport.preset === p.id}
                  onClick={() => {
                    onViewport({ w: p.w, h: p.h, preset: p.id });
                    setVpOpen(false);
                  }}
                >
                  <span>{p.label}</span>
                  <span className={s.viewportSize}>{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {showZoom && (
        <>
          <div className={s.toolDivider} aria-hidden="true" />
          <button
            className={`${s.iconBtn} ${s.zoomBtn}`}
            onClick={() => onZoom(zoom === 0.5 ? 0.75 : zoom === 0.75 ? 1 : 0.5)}
            title="Cycle zoom: 50% → 75% → 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
        </>
      )}

    </div>
  );
}

/* ─── Canvas frame (one iframe + click-capture wiring) ───────────
 *
 * Hover/select OUTLINES are drawn HERE in the parent (over the iframe)
 * rather than injected into the iframe document. The iframe emits
 * `rect` updates and the parent draws — three wins:
 *   1. The outline never gets baked into export screenshots.
 *   2. The outline doesn't fight `transform: scale(zoom)` on the iframe.
 *   3. Clicks always land on iframe content — the outline is in a
 *      sibling <div> with pointer-events:none.
 *
 * Hover is IMPERATIVE — mousemove writes the overlay div's style
 * directly, no React state and no parent re-render. With React state
 * the every-frame setHoveredSelector path forced a full re-render of
 * the 3000-line Editor on each mouse twitch and the outline
 * "stuttered" (felt like clicks were required to make selection
 * happen). Selection state stays React because it changes rarely.
 *
 * For external hover sources (Layers panel hovering a row), the parent
 * gets a forwardRef'd handle exposing `paintHoverBySelector`. */
type RectLike = { x: number; y: number; w: number; h: number };

export type CanvasFrameHandle = {
  /** Show the hover outline at the given selector. Pass null to hide. */
  paintHoverBySelector: (sel: string | null) => void;
  /** Force-refresh the iframe by bumping a reload-key into its src.
   *  Use this instead of `ifr.src = ifr.src`, which Chromium can no-op
   *  when the URL is identical. */
  reloadFrame: () => void;
};

const CanvasFrame = forwardRef<CanvasFrameHandle, {
  tab: Tab;
  projectId: string;
  mode: Mode;
  zoom: number;
  selected: SelectedInfo | null;
  /** While a comment bubble is open, the parent passes its anchor here
   *  so we keep an outline around the element being commented on. The
   *  bubble itself just shows `<a>` text — without this outline the
   *  user can't tell which element on screen the comment is attached to. */
  commentTarget: CommentTarget | null;
  onSelect: (sel: SelectedInfo | null, extend?: boolean) => void;
  onComment: (target: CommentTarget) => void;
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
}>(function CanvasFrame({
  tab,
  projectId,
  mode,
  zoom,
  selected,
  commentTarget,
  onSelect,
  onComment,
  iframeRef: parentIframeRef,
}, handleRef) {
  // Sandbox tab → /p/<id>/<route>. tab.route is project-relative (e.g.
  // "index.html" or "_preview/Button.jsx"). Otherwise treat route as a
  // SPA path (legacy fallback during the migration window). The
  // reloadKey appended to the URL is a force-refresh signal — bumping
  // it changes the URL identity so Chromium doesn't no-op the reload.
  const [reloadKey, setReloadKey] = useState(0);
  const baseSrc = projectId
    ? `/p/${encodeURIComponent(projectId)}/${tab.route.replace(/^\/+/, "")}`
    : tab.route;
  const iframeSrc = reloadKey > 0
    ? `${baseSrc}${baseSrc.includes("?") ? "&" : "?"}r=${reloadKey}`
    : baseSrc;
  // Until the iframe's first onLoad fires, render a soft placeholder so
  // the canvas isn't a blank rectangle during cold loads (project /
  // tab switches, forced reloads).
  const [iframeReady, setIframeReady] = useState(false);
  useEffect(() => { setIframeReady(false); }, [baseSrc, reloadKey]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // State mirror of the iframe element — children that want to subscribe to
  // postMessage events scoped to this iframe (e.g. IframeErrorOverlay) need
  // a re-rendering signal when the element identity changes (project / tab
  // switch reuses the same DOM node sometimes, swaps it other times).
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  // Fixed device viewport in frame mode — content scrolls inside it.
  // The earlier auto-size loop (ResizeObserver + min-height strip /
  // restore + setSize feedback) caused visible flicker because every
  // measurement forced a reflow inside the iframe and any height change
  // jumped under the zoom transform. Omelette / Figma / Webflow all use
  // a fixed device viewport for the same reason.
  const size = { w: tab.viewport?.w ?? 1280, h: tab.viewport?.h ?? 820 };

  // Mirror our local iframe ref out to the parent so it can capture screenshots.
  // Also publish the element identity into state for children that need a
  // re-render signal when the iframe DOM node swaps (IframeErrorOverlay).
  // We compare-then-set so the effect doesn't drive an infinite update loop.
  useEffect(() => {
    parentIframeRef.current = iframeRef.current;
    setIframeEl((cur) => (cur === iframeRef.current ? cur : iframeRef.current));
    return () => {
      if (parentIframeRef.current === iframeRef.current) parentIframeRef.current = null;
    };
  });

  // On iframe load: replay persisted overrides + inject the DM script.
  // Crucial detail: many of our routes are React SPAs that hydrate AFTER
  // window.onload. A single applyOverrides() on load runs against an empty
  // <div id="root"></div> — none of the user's overridden elements exist
  // yet, so nothing visible changes. We watch the body for mutations and
  // re-apply on every burst (debounced) so overrides land as soon as React
  // mounts the targeted nodes. Cheap because applyOverrides only calls
  // setProperty on a small number of selectors.
  const onLoad = useCallback(() => {
    const ifr = iframeRef.current;
    const doc = ifr?.contentDocument;
    if (!ifr || !doc) return;
    setIframeReady(true);
    applyOverrides(doc, tab.route);
    applySharedAssetsToDoc(doc);
    DmBridge.inject(ifr);
    // Adds <link rel="stylesheet" href="_inspector_edits.css"> to the
    // iframe head so saved inspector edits get picked up on every load.
    // Resolves against /p/<id>/... so the project's static middleware
    // serves it. Browser logs a 404 until the user has saved at least
    // one edit — harmless in dev.
    DmBridge.injectInspectorCSS(ifr);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const reapply = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try { applyOverrides(doc, tab.route); } catch { /* ignore */ }
      }, 80);
    };
    const mo = new MutationObserver(reapply);
    try {
      mo.observe(doc.body, { childList: true, subtree: true });
    } catch { /* doc may have unloaded */ }
    // Stash the disposer on the iframe so the next load tears it down.
    const slot = iframeRef.current as unknown as { __overridesMo?: () => void };
    slot.__overridesMo?.();
    slot.__overridesMo = () => {
      mo.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [tab.route]);

  // "Pan mode" — when zoomed out far enough that individual elements
  // can't be reliably picked, we treat the canvas as navigation-only:
  //   - Skip the mousemove → paintHover → getBoundingClientRect path
  //     (every mousemove forces a synchronous layout flush; on a heavy
  //     iframe with 30+ frames that's expensive enough to drop frames
  //     visibly — the "blink at far zoom" the user reported).
  //   - Hide the selection overlay (it's pixel-thin and useless at low
  //     zoom anyway).
  //   - Set a data-attribute on the iframe doc; inject-script applies a
  //     CSS rule that pauses all animations + transitions while it's
  //     present, so the iframe content also stops doing work.
  // 0.4 is the empirical threshold; anything below ~40% zoom looks
  // like a thumbnail grid where elements are too small to interact with.
  const isPanMode = tab.display === "frame" && zoom < 0.4;

  // Tell the iframe to freeze: pauses CSS animations + transitions via
  // an attribute selector the inject-script registers, and pauses any
  // <video> elements via JS. Unfreezes on the way back.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    const html = doc?.documentElement;
    if (!html) return;
    if (isPanMode) {
      html.setAttribute("data-cc-frozen", "1");
      try { doc?.querySelectorAll("video").forEach((v) => v.pause()); }
      catch { /* ignore */ }
    } else {
      html.removeAttribute("data-cc-frozen");
      try {
        doc?.querySelectorAll<HTMLVideoElement>("video[autoplay]").forEach((v) => {
          // play() returns a Promise; swallow rejection (browsers may
          // refuse autoplay without user gesture, harmless here).
          v.play().catch(() => {});
        });
      } catch { /* ignore */ }
    }
  }, [isPanMode]);

  // Parent-side rect state — what the SELECTED overlay draws. Hover
  // is imperative (see hoverBoxRef + paintHover below) to avoid a full
  // Editor re-render on every mousemove tick.
  const [selectedRect, setSelectedRect] = useState<RectLike | null>(null);
  /** The hover-outline div. We mutate its style directly via paintHover
   *  rather than rendering a React-controlled position/size. */
  const hoverBoxRef = useRef<HTMLDivElement | null>(null);
  /** Last hovered element so `paintHover` can re-run on scroll/zoom
   *  without needing a fresh mousemove event. */
  const lastHoveredEl = useRef<HTMLElement | null>(null);
  /** Imperative hover repaint. No React state — straight DOM writes.
   *  Skips work when the rect is identical to the last paint (cuts the
   *  per-frame style-write churn that caused the dashed outline to
   *  visibly flicker as the cursor moved within a stable element). */
  const lastHoverRect = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const paintHover = useCallback((el: HTMLElement | null) => {
    const box = hoverBoxRef.current;
    if (!box) { lastHoveredEl.current = el; return; }
    if (!el || !el.isConnected) {
      lastHoveredEl.current = null;
      lastHoverRect.current = null;
      box.style.display = "none";
      return;
    }
    lastHoveredEl.current = el;
    const r = el.getBoundingClientRect();
    const k = tab.display === "frame" ? zoom : 1;
    // Round to integers — same reasoning as the selectedRect dedup.
    // Subpixel drift on busy pages otherwise causes the hover outline
    // to repaint every frame even when the cursor is stationary.
    const x = Math.round(r.left * k);
    const y = Math.round(r.top * k);
    const w = Math.round(r.width * k);
    const h = Math.round(r.height * k);
    const prev = lastHoverRect.current;
    if (prev && prev.x === x && prev.y === y && prev.w === w && prev.h === h) return;
    lastHoverRect.current = { x, y, w, h };
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.display = "block";
  }, [tab.display, zoom]);
  // Expose paintHoverBySelector to the parent so the Layers panel can
  // drive hover from outside the iframe (hover a row → outline an
  // element). Same imperative path; no React state involved.
  useImperativeHandle(handleRef, () => ({
    paintHoverBySelector: (sel: string | null) => {
      const doc = iframeRef.current?.contentDocument;
      if (!doc || !sel) { paintHover(null); return; }
      const el = resolveCssPath(doc, sel) as HTMLElement | null;
      paintHover(el);
    },
    reloadFrame: () => setReloadKey((k) => k + 1),
  }), [paintHover]);

  // Hook click-to-select / hover-outline whenever mode or active tab change.
  // Used by both Edit (selects element + opens inspector) and Comment (pins
  // a bubble at the click point).
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    // "select" mode (no tool active) ALSO gets hover + click-to-select so
    // the chat composer always knows what the user is pointing at. The
    // Inspector only renders when mode === "edit", so click-in-select
    // populates `selected` (composerContext + descriptor for the AI)
    // without opening the editing UI. "draw" is the only mode where we
    // want to ignore picks — it has its own canvas overlay.
    if (mode === "draw") {
      paintHover(null);
      return;
    }
    // At extreme zoom-out, the canvas is for navigation, not picking.
    // Skip the entire mousemove/click pipeline so heavy iframes don't
    // pay the per-frame getBoundingClientRect tax (it triggers forced
    // synchronous layout, which is what makes far-zoom feel laggy).
    if (isPanMode) {
      paintHover(null);
      return;
    }

    /** Tell the inject-script "this element is the new primary" so its
     *  drill-into-selection logic works on the next click (when you
     *  click a child INSIDE the current selection, the inject-script
     *  prefers it/descendants over whatever has higher z-index). We
     *  do this by sending the iframe a `pick` at the click coords —
     *  cheap, async, no round-trip needed for the main UI flow. */
    const syncPrimaryRef = (e: MouseEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage(
          { __DM_CMD__: { type: "pick", x: e.clientX, y: e.clientY, select: true } },
          "*",
        );
      } catch { /* ignore */ }
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || target.nodeType !== 1) return;
      // On canvas-mode pages (DesignCanvas), don't intercept clicks on
      // the canvas's own chrome. The editor attaches `click` in capture
      // phase (see addEventListener at the bottom of this effect), so
      // without a guard it would eat events meant for the canvas's own
      // handlers — the drag-grip, expand button, kebab menu, and inline
      // label/title editors would all silently stop working.
      //
      // Skip anything inside an inline-editable canvas control:
      if (target.closest(".dc-editable")) return;
      // Skip anything inside a [data-dc-slot] (an artboard) BUT outside
      // .dc-card. .dc-card holds user-authored content (still
      // selectable for chat/inspect); everything else inside the slot
      // — label, grip, expand, kebab — is canvas chrome.
      if (target.closest("[data-dc-slot]") && !target.closest(".dc-card")) return;
      e.preventDefault();
      e.stopPropagation();
      const sel = cssPath(target);
      syncPrimaryRef(e);

      // Edit mode: select + open inspector (handled by JSX based on mode).
      // Select mode: select for chat context only (no inspector, no edits).
      // Both call onSelect; the inspector renders only when mode === "edit".
      if (mode === "edit" || mode === "select") {
        const computed = doc.defaultView!.getComputedStyle(target);
        const descriptor = buildDescriptor(target);
        onSelect({ selector: sel, tag: target.tagName.toLowerCase(), computed, descriptor }, e.shiftKey);
        return;
      }

      if (mode === "export") {
        // Click selects (just like edit mode), it does NOT capture. The
        // popover then shows what's selected with ↑ Parent + Capture so
        // the user can correct a wrong child-hit before committing.
        const computed = doc.defaultView!.getComputedStyle(target);
        const descriptor = buildDescriptor(target);
        onSelect({ selector: sel, tag: target.tagName.toLowerCase(), computed, descriptor }, e.shiftKey);
        return;
      }

      // Comment mode — compute two anchors:
      //   bubbleXY = canvas-local px for the floating bubble (transient).
      //   localXY = iframe-content px for the pin (zoom-invariant).
      const ifr = iframeRef.current;
      if (!ifr) return;
      const ifrRect = ifr.getBoundingClientRect();
      const canvasParent = ifr.closest('[class*="canvas"]') as HTMLElement | null;
      const canvasRect = canvasParent?.getBoundingClientRect() ?? ifrRect;

      // Iframe-local content coords = element rect center inside the iframe.
      const er = (target as HTMLElement).getBoundingClientRect();
      const localX = er.left + er.width / 2;
      const localY = er.top + er.height / 2;

      // Bubble screen pos: iframe-local mouse → screen (× zoom in framed mode)
      // → canvas-local.
      const k = tab.display === "frame" ? zoom : 1;
      const x = ifrRect.left + e.clientX * k - canvasRect.left;
      const y = ifrRect.top + e.clientY * k - canvasRect.top;

      // Resolve smart-label kind right here while computed style is
      // live — the bubble + LocalComment + chat ref all consume `kind`
      // and `descriptor.label` is byte-frozen for the AI prompt path.
      const commentDescriptor = buildDescriptor(target);
      const commentComputed = doc.defaultView!.getComputedStyle(target);
      const commentKind = classifyKind({
        descriptor: commentDescriptor,
        computed: computedHints(commentComputed, target),
      });
      onComment({
        x,
        y,
        localX,
        localY,
        selector: sel,
        tag: target.tagName.toLowerCase(),
        innerText: (target as HTMLElement).innerText?.slice(0, 280),
        outerHtml: (target as HTMLElement).outerHTML?.slice(0, 1500),
        descriptor: commentDescriptor,
        kind: commentKind,
      });
    };
    // Hover outline — imperative DOM write coalesced to one repaint
    // per animation frame. Skipping React state here is the difference
    // between buttery hover and one that feels like clicks are needed:
    // the old setState path was forcing a full Editor re-render on
    // every mouse twitch.
    let hoverTarget: HTMLElement | null = null;
    let hoverRaf = 0;
    const flushHover = () => {
      hoverRaf = 0;
      paintHover(hoverTarget);
    };
    const onMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.nodeType !== 1) return;
      hoverTarget = target;
      if (!hoverRaf) hoverRaf = requestAnimationFrame(flushHover);
    };

    // Drag-to-reposition (Edit mode only). Active when the selected
    // element has position absolute/fixed/relative — otherwise it's a
    // normal click. We track movement; > 4px = drag, else click.
    let dragState: null | {
      el: HTMLElement;
      startX: number;
      startY: number;
      origLeft: number;
      origTop: number;
      moved: boolean;
    } = null;

    const onPointerDown = (e: PointerEvent) => {
      if (mode !== "edit") return;
      const target = e.target as HTMLElement | null;
      if (!target || target.nodeType !== 1) return;
      const cs = doc.defaultView?.getComputedStyle(target);
      if (!cs) return;
      const pos = cs.position;
      if (pos !== "absolute" && pos !== "fixed" && pos !== "relative") return;
      // Only drag when this element matches the current selection.
      const sel = cssPath(target);
      if (selected?.selector !== sel) return;
      dragState = {
        el: target,
        startX: e.clientX,
        startY: e.clientY,
        origLeft: parseFloat(cs.left) || 0,
        origTop: parseFloat(cs.top) || 0,
        moved: false,
      };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (!dragState.moved) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragState.moved = true;
        // Snapshot once on first real movement so visual undo can restore.
        // Direct postMessage so we don't depend on the parent's dmRef.
        const w = parentIframeRef.current?.contentWindow;
        try { w?.postMessage({ __DM_CMD__: { type: "snapshot" } }, "*"); }
        catch { /* ignore */ }
      }
      e.preventDefault();
      dragState.el.style.left = `${dragState.origLeft + dx}px`;
      dragState.el.style.top = `${dragState.origTop + dy}px`;
    };
    const onPointerUp = () => {
      if (!dragState) return;
      const moved = dragState.moved;
      const el = dragState.el;
      dragState = null;
      if (moved) {
        // Persist final inline left/top as overrides.
        const sel = cssPath(el);
        setOverride(tab.route, sel, "left", el.style.left);
        setOverride(tab.route, sel, "top", el.style.top);
      }
    };
    const onLeave = () => {
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
      hoverTarget = null;
      paintHover(null);
    };

    doc.addEventListener("click", onClick, true);
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mouseleave", onLeave, true);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointermove", onPointerMove, true);
    doc.addEventListener("pointerup", onPointerUp, true);
    return () => {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseleave", onLeave, true);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointermove", onPointerMove, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      // Don't clear hover on cleanup — this effect re-runs on every
      // `selected` / props change, and clearing here would cause the
      // hover outline to blink off for one frame on every click. The
      // explicit early-return branch above (mode change) still clears,
      // and onLeave clears when the cursor actually leaves the iframe.
    };
  }, [mode, tab.id, tab.display, tab.route, zoom, selected, onSelect, onComment, paintHover, isPanMode]);

  // The "pinned" selector is whatever should currently be outlined.
  // Comment bubble takes priority over Edit-mode selection so the user
  // can see what they're commenting on; otherwise Edit-mode `selected`
  // wins. Without this, opening the comment bubble dropped the outline
  // and the user had no idea which element on screen the bubble was
  // attached to.
  const pinnedSelector = commentTarget?.selector ?? selected?.selector ?? null;

  // Track the pinned element's rect.
  //
  // useLayoutEffect runs before paint so the rect is fresh on the
  // initial render after a selection change.
  //
  // Strategy:
  //   - Scroll (capture=true catches nested scrollers) + resize on the
  //     iframe window → schedule a measure.
  //   - Debounced ResizeObserver on iframe body → catches page reflow
  //     (image loads, font swaps, AI-driven content changes) without
  //     firing on every individual element settle.
  //   - MutationObserver on `style` attribute (subtree=documentElement)
  //     → catches transform-driven motion: in-iframe canvases that pan/
  //     zoom by writing `el.style.transform = translate3d(...)` (e.g.
  //     `DCViewport` in projects/demo/design-canvas.jsx), JS-driven
  //     element drag (Editor.tsx writes `style.left/top` for repositioning),
  //     and AI mutations that touch inline style. Without this, none of
  //     scroll/resize/RO fire and the overlay drifts off the element.
  //   - Transition/animation events on the iframe doc → arm the settle
  //     window so CSS transitions/animations on ancestors get sampled
  //     every frame for their full duration (the engine interpolates
  //     between style values without firing MutationObserver).
  //   - "Settle window": for ~1 second after pinnedSelector changes
  //     and after every scroll/transition/animation, run rAF every
  //     frame so post-action reflows reposition the box quickly. After
  //     1s the loop stops and we go back to event-driven.
  //
  // This covers the "box drifts after I click / scroll / pan / zoom"
  // case the user reported without burning CPU when the page is idle.
  useLayoutEffect(() => {
    if (!pinnedSelector || isPanMode) {
      setSelectedRect(null);
      return;
    }
    const doc = iframeRef.current?.contentDocument;
    const win = doc?.defaultView ?? null;
    if (!doc || !win) return;
    let raf = 0;
    let prev: RectLike | null = null;
    const measure = () => {
      raf = 0;
      const el = resolveCssPath(doc, pinnedSelector) as HTMLElement | null;
      if (!el) {
        if (prev !== null) { prev = null; setSelectedRect(null); }
        return;
      }
      const r = el.getBoundingClientRect();
      // Pixel dedup so subpixel drift doesn't trigger React updates.
      const x = Math.round(r.left);
      const y = Math.round(r.top);
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (prev && prev.x === x && prev.y === y && prev.w === w && prev.h === h) return;
      prev = { x, y, w, h };
      setSelectedRect(prev);
      if (lastHoveredEl.current) paintHover(lastHoveredEl.current);
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    // Settle window: rAF every frame for ~1s, re-armed on scroll.
    let settleUntil = performance.now() + 1000;
    let settleRaf = 0;
    const settleTick = () => {
      settleRaf = 0;
      measure();
      if (performance.now() < settleUntil) {
        settleRaf = requestAnimationFrame(settleTick);
      }
    };
    const armSettle = () => {
      settleUntil = performance.now() + 1000;
      if (!settleRaf) settleRaf = requestAnimationFrame(settleTick);
    };

    const onScroll = () => { schedule(); armSettle(); };
    measure();
    armSettle();
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", schedule);

    let ro: ResizeObserver | null = null;
    let roDebounce: ReturnType<typeof setTimeout> | null = null;
    if (typeof ResizeObserver !== "undefined" && doc.body) {
      ro = new ResizeObserver(() => {
        if (roDebounce) clearTimeout(roDebounce);
        roDebounce = setTimeout(() => { roDebounce = null; schedule(); }, 80);
      });
      ro.observe(doc.body);
    }

    // Observe inline-style mutations on every element under the iframe
    // doc. Catches transform-driven motion (e.g. DCViewport's per-pan
    // `style.transform = translate3d(...)` writes) and any other JS-
    // driven style change that moves an ancestor of the pinned element.
    // schedule() rAF-coalesces, so a 60fps pan collapses to one
    // measure() per frame — same cost as the existing scroll path.
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined" && doc.documentElement) {
      mo = new MutationObserver(schedule);
      mo.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    }

    // CSS transitions and animations interpolate between style values
    // WITHOUT writing the style attribute on each frame — MutationObserver
    // can't see those interpolated frames. Arm the settle window on
    // transition/animation lifecycle events so the rAF loop tracks the
    // full duration; the dedup in measure() keeps it cheap when nothing
    // visibly changes between frames.
    const onAnimEvent = () => { schedule(); armSettle(); };
    const animEvents = [
      "transitionrun", "transitionend", "transitioncancel",
      "animationstart", "animationend", "animationiteration", "animationcancel",
    ] as const;
    for (const ev of animEvents) doc.addEventListener(ev, onAnimEvent, true);

    return () => {
      win.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", schedule);
      ro?.disconnect();
      mo?.disconnect();
      for (const ev of animEvents) doc.removeEventListener(ev, onAnimEvent, true);
      if (roDebounce) clearTimeout(roDebounce);
      if (raf) cancelAnimationFrame(raf);
      if (settleRaf) cancelAnimationFrame(settleRaf);
    };
    // iframeReady + reloadKey are load-bearing: when the iframe element
    // remounts (e.g. the canvas-snap toggling display from "frame" to
    // "fill" on first __page_is_canvas, or a force-reload bumping
    // reloadKey), `doc`/`win`/`mo` above bind to the *prior*
    // contentDocument. Without re-subscribing, transform writes from the
    // freshly-mounted DesignCanvas's pan/zoom land on a detached
    // documentElement and the overlay drifts off the element. Adding both
    // to the deps array forces a clean re-attach on every iframe identity
    // change. (Symptom this fixed: select an element, drag-pan the
    // canvas, the parent-side selection rectangle stayed put while the
    // element moved underneath it — the MutationObserver was firing on a
    // ghost.)
  }, [pinnedSelector, zoom, tab.id, paintHover, isPanMode, iframeReady, reloadKey]);

  // Coordinate scale for the overlay. In framed mode the iframe is
  // visually scaled by `zoom`, so iframe-content rects need to be
  // multiplied by zoom to land in `.frame` coords. In fill mode the
  // iframe is at 1:1.
  const overlayK = tab.display === "frame" ? zoom : 1;
  const overlay = (
    <div className={s.frameOverlay} aria-hidden>
      {/* Hover box is permanent in the DOM; paintHover toggles its
       *  display + writes left/top/width/height directly. Rendering it
       *  always (even when display:none) means we never tear down/re-
       *  create the node — the imperative writes target a stable ref.
       *
       *  CRITICAL: NO `style` prop here. The CSS class sets the initial
       *  display:none. If we passed `style={{display:"none"}}`, React
       *  would diff a fresh object on every CanvasFrame render and
       *  re-apply display:none — clobbering our imperative `display:
       *  block` write for one frame each time. That was the residual
       *  flicker the user kept seeing after we moved hover off React
       *  state. */}
      <div
        ref={hoverBoxRef}
        className={`${s.outlineBox} ${s.outlineHover}`}
      />
      {selectedRect && (
        <div
          className={`${s.outlineBox} ${s.outlineSelect}`}
          style={{
            left: selectedRect.x * overlayK,
            top: selectedRect.y * overlayK,
            width: selectedRect.w * overlayK,
            height: selectedRect.h * overlayK,
          }}
        />
      )}
    </div>
  );

  // A file row dragged onto the canvas should feed the chat composer the
  // same way dropping on it directly does. We dispatch a window event the
  // composer listens for; the canvas itself doesn't try to mutate the
  // iframe because edits aren't persistent unless they go through chat.
  const onCanvasDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-cc-file-path")) return;
    e.preventDefault();
    const path = e.dataTransfer.getData("application/x-cc-file-path");
    if (path) window.dispatchEvent(new CustomEvent("cc-canvas-file-drop", { detail: path }));
  };
  const onCanvasDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-cc-file-path")) e.preventDefault();
  };

  if (tab.display === "fill") {
    return (
      <div className={s.frame} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}>
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title={tab.label}
          onLoad={onLoad}
        />
        {!iframeReady && <CanvasFirstPaint />}
        {overlay}
        <Suspense fallback={null}>
          <IframeErrorOverlay iframe={iframeEl} />
        </Suspense>
      </div>
    );
  }

  // Framed (Figma-style) — content sized + scaled, sits on the gridded canvas
  const frameW = size.w * zoom;
  const frameH = size.h * zoom;
  return (
    <div
      className={s.frame}
      style={{ width: frameW, height: frameH }}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title={tab.label}
        onLoad={onLoad}
        style={{
          width: size.w,
          height: size.h,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}
      />
      {!iframeReady && <CanvasFirstPaint />}
      {overlay}
      <Suspense fallback={null}>
        <IframeErrorOverlay iframe={iframeEl} />
      </Suspense>
    </div>
  );
});

/** Soft placeholder shown over the iframe until its first onLoad
 *  fires. Avoids a stark blank rectangle during cold loads (initial
 *  mount, project switch, tab switch, forced reload). */
function CanvasFirstPaint() {
  return (
    <div className={s.canvasFirstPaint} aria-hidden="true">
      <Spinner size={18} label="Loading preview" />
    </div>
  );
}

/* ─── Iframe-side helpers ────────────────────────────────────── */
function getActiveDoc(): Document | null {
  const ifr = document.querySelector("iframe") as HTMLIFrameElement | null;
  return ifr?.contentDocument ?? null;
}
