/* ChatSidebar.tsx — right-side conversation panel.
 *
 * The top-level <ChatSidebar> wrapper used to live here too, but the
 * Editor now mounts <ChatTab> directly via LeftPanel; only the chat tab
 * + supporting bubbles + composer ship from this module. The shared
 * types (ChatMessage, ChatThread, ThreadArchive, QueuedMessage) and the
 * <ChatBody> / <Composer> / <QueuedBubble> components are re-exported
 * for the onboarding full-page chat to reuse without forking.
 */

import { useEffect, useRef, useState } from "react";
import s from "./chat.module.css";
import type { Attachment } from "./CommentBubble";
import { ModelPicker, loadModelId, saveModelId, useModelPickerFlag } from "./ModelPicker";
import { getModel } from "../../data/modelPresets";
import { Markdown, DiffBlock } from "./Markdown";
import { ElicitForm } from "./ElicitForm";
import { ArtifactCard, parseArtifact } from "./ArtifactCard";
import { ImageLightbox } from "./ImageLightbox";
import { getStreamState, type ElicitRequest, type ToolCall, type TurnUsage } from "../../lib/chatStream";

export type ChatMessage =
  | {
      role: "user";
      content: string;
      route?: string;
      selector?: string;
      tag?: string;
      /** Short text snippet from the clicked element (helps identify it). */
      innerText?: string;
      /** Rich element profile attached to this turn — what the AI saw
       *  for "the thing the user clicked on". Persists with the message. */
      descriptor?: import("../../lib/cssPath").ElementDescriptor;
      /** Small data-URL screenshot of how the page looked at comment time. */
      thumbnail?: string;
      /** Serialized iframe body outerHTML at comment time (for restore). */
      domHtml?: string;
      /** Per-ref inline-style map for surgical restore. */
      styles?: Record<string, string>;
      /** Files the user explicitly attached via the paperclip / paste.
       *  Distinct from `thumbnail` (the auto-canvas snapshot) so the bubble
       *  can render both without mixing them up, and so a future composer
       *  can re-attach them on edit/resend. */
      attachments?: Attachment[];
      /** Hidden text prepended to `content` when this turn is sent to
       *  the AI but never rendered in the bubble. Used to ride the
       *  project intake brief along with the user's first message —
       *  the user sees only what they typed, Claude reads brief + text. */
      preamble?: string;
      /** Iframe scroll position at comment time. */
      scrollX?: number;
      scrollY?: number;
      /** Module-level chatStream id for re-attach across HMR remount. */
      streamId?: string;
      /** Which model the user sent this message to. */
      modelId?: string;
      /** When true the bubble is hidden from the chat UI. Used for the
       *  onboarding intake prompt — Claude reads it but the user
       *  shouldn't see a wall of system instructions in their chat. */
      hidden?: boolean;
      ts: number;
    }
  | {
      role: "assistant";
      content: string;       // accumulated text
      thinking?: string;     // accumulated extended-thinking content (collapsible)
      tools: ToolCall[];     // tool calls made during this turn (expandable in UI)
      ts: number;
      pending?: boolean;     // still streaming
      error?: string;
      turnId?: string;       // server-side snapshot id for undo
      reverted?: boolean;    // edits for this turn have been undone
    };

export type ChatThread = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  /** The model used for the first turn (informative only). */
  modelId?: string;
};

export type ThreadArchive = {
  threads: ChatThread[];
  activeId: string | null;
};

/** A composer message the user typed while the active turn was still
 *  in-flight. Held at the route level until the turn drains, then
 *  auto-fired through the same `onSend` path. Only one queued at a time. */
export type QueuedMessage = {
  text: string;
  attachments: Attachment[];
  modelId: string;
  queuedAt: number;
};

export function ChatTab({
  threads,
  activeThread,
  onNewThread,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onUndo,
  onRetry,
  onDeleteMessage,
  onSend,
  onRestore,
  pendingElicit,
  onElicitResolved,
  onStop,
  composerContext,
  onClearComposerContext,
  queuedMessage,
  onCancelQueued,
  showCanvasToggle,
}: {
  threads: ChatThread[];
  activeThread: ChatThread | null;
  onNewThread: () => void;
  onSwitchThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onUndo: (turnId: string) => void;
  onRetry: (threadId: string, userIndex: number) => void;
  onDeleteMessage: (threadId: string, index: number) => void;
  onSend: (
    text: string,
    attachments: Attachment[],
    modelId: string,
    opts?: { includeCanvas?: boolean },
  ) => void;
  onRestore?: (m: Extract<ChatMessage, { role: "user" }>) => void;
  pendingElicit?: ElicitRequest | null;
  onElicitResolved?: () => void;
  onStop?: () => void;
  /** Human-readable label of the context the next turn will carry. */
  composerContext?: string;
  /** Drop the selected element from the next turn — wired to an × on
   *  the context pill. When omitted the × isn't rendered. */
  onClearComposerContext?: () => void;
  /** A message held until the in-flight turn drains. */
  queuedMessage?: QueuedMessage | null;
  /** Cancel the queued message. */
  onCancelQueued?: () => void;
  /** Show the "📷 Current view" composer chip with × to skip the auto
   *  iframe screenshot for the next turn. Editor enables this; Onboard
   *  doesn't (no iframe). */
  showCanvasToggle?: boolean;
}) {
  // Seed-text signal for "edit this user message and resend": when the
  // pencil is clicked on a user bubble, we truncate the thread from that
  // index and bump the seed so the Composer drops the original text into
  // its textarea for editing.
  const [editSeed, setEditSeed] = useState<{ text: string; nonce: number } | null>(null);
  return (
    <>
      <ThreadTabs
        threads={threads}
        activeId={activeThread?.id ?? null}
        onSwitch={onSwitchThread}
        onDelete={onDeleteThread}
        onRename={onRenameThread}
        onNew={onNewThread}
      />
      <ChatBody
        thread={activeThread}
        threadId={activeThread?.id ?? ""}
        onUndo={onUndo}
        onRetry={onRetry}
        onDeleteMessage={onDeleteMessage}
        onRestore={onRestore}
        onSendStarter={(text) => onSend(text, [], loadModelId())}
        onEditMessage={(tid, idx, text) => {
          // Truncate the thread from this index and pop the original
          // text into the Composer for editing.
          onDeleteMessage(tid, idx);
          setEditSeed({ text, nonce: Date.now() });
        }}
      />
      {pendingElicit && (
        <ElicitForm
          key={pendingElicit.id}
          request={pendingElicit}
          onResolved={onElicitResolved ?? (() => {})}
        />
      )}
      {queuedMessage && (
        <QueuedBubble
          message={queuedMessage}
          onCancel={onCancelQueued ?? (() => {})}
        />
      )}
      <Composer
        disabled={!!activeThread && (isAssistantPending(activeThread) || !!pendingElicit)}
        hasQueued={!!queuedMessage}
        onSend={onSend}
        onStop={!!activeThread && isAssistantPending(activeThread) ? onStop : undefined}
        draftKey={activeThread ? `chat-draft:${activeThread.id}` : undefined}
        contextLabel={composerContext}
        onClearContext={onClearComposerContext}
        showCanvasToggle={showCanvasToggle}
        seedText={editSeed?.text}
        seedNonce={editSeed?.nonce}
        onSlashAction={(action) => {
          if (action === "new-thread") onNewThread();
          else if (action === "clear" && activeThread) {
            // Delete from index 0 (truncate the entire thread).
            onDeleteMessage(activeThread.id, 0);
          } else if (action === "copy" && activeThread && typeof navigator !== "undefined") {
            const text = activeThread.messages
              .map((m) => m.role === "user" ? `> ${m.content}` : m.content)
              .join("\n\n");
            navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
          }
        }}
      />
    </>
  );
}

function ThreadTabs({
  threads,
  activeId,
  onSwitch,
  onDelete,
  onRename,
  onNew,
}: {
  threads: ChatThread[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (id: string, title: string) => {
    setEditingId(id);
    setDraft(title);
  };
  const commitEdit = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  return (
    <div className={s.threadTabBar}>
      {threads.map((t) => {
        const isActive = t.id === activeId;
        if (editingId === t.id) {
          return (
            <input
              key={t.id}
              autoFocus
              className={s.threadTabInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                else if (e.key === "Escape") setEditingId(null);
              }}
            />
          );
        }
        return (
          <div
            key={t.id}
            className={`${s.threadTab} ${isActive ? s.threadTabActive : ""}`}
            onClick={() => onSwitch(t.id)}
            onDoubleClick={() => startEdit(t.id, t.title)}
            title={`${t.title} · double-click to rename`}
          >
            <span className={s.threadTabTitle}>{t.title}</span>
            {threads.length > 1 && (
              <button
                type="button"
                className={s.threadTabClose}
                onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                aria-label="Close thread"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className={s.threadTabAdd}
        onClick={onNew}
        title="New thread"
        aria-label="New thread"
      >
        +
      </button>
    </div>
  );
}

function isAssistantPending(thread: ChatThread): boolean {
  const last = thread.messages[thread.messages.length - 1];
  return !!(last && last.role === "assistant" && last.pending);
}

function Composer({
  disabled,
  hasQueued,
  onSend,
  onStop,
  draftKey,
  contextLabel,
  onClearContext,
  onSlashAction,
  seedText,
  seedNonce,
  showCanvasToggle,
}: {
  disabled: boolean;
  /** True when the route is already holding a queued message. The submit
   *  path still fires (replacing the queued message) but the placeholder
   *  + send-button styling reflect the "you can queue another / it'll
   *  replace what's queued" state. */
  hasQueued?: boolean;
  /** Optional 4th arg `opts.includeCanvas` lets the composer tell the route
   *  whether to capture a fresh iframe screenshot for this turn. Routes
   *  that don't pass `showCanvasToggle` ignore it (Onboard has no iframe). */
  onSend: (
    text: string,
    attachments: Attachment[],
    modelId: string,
    opts?: { includeCanvas?: boolean },
  ) => void;
  /** When provided AND `disabled` is true, the send button becomes a Stop
   *  button that calls this. Lets the user abort an in-flight reply. */
  onStop?: () => void;
  /** Surface the "📷 Current view" chip + remove/restore control. Only the
   *  Editor's main composer enables this — Onboard and other surfaces
   *  without an iframe omit it (the snapshot fires unconditionally there
   *  via runTurn's existing path). */
  showCanvasToggle?: boolean;
  /** Stable per-thread storage key for the typed-but-unsent draft.
   *  Survives reloads; cleared on send. Pass undefined to disable. */
  draftKey?: string;
  /** Optional pill above the textarea — shows what context the next turn
   *  will carry (active file, selected element). Mirrors Cursor / Continue
   *  UX so the user knows what Claude actually sees. */
  contextLabel?: string;
  /** When set, the context pill shows an × button that calls this — used
   *  to drop a picked element from the next turn without re-clicking
   *  somewhere else first. */
  onClearContext?: () => void;
  /** Handler for slash-command actions that don't translate to a prompt
   *  (new-thread, clear, copy). Prompts are sent through onSend directly. */
  onSlashAction?: (action: "new-thread" | "clear" | "copy") => void;
  /** One-shot seed: when `seedNonce` changes, replaces the textarea with
   *  `seedText` (used by the edit-and-resubmit flow). */
  seedText?: string;
  seedNonce?: number;
}) {
  const [text, setText] = useState<string>(() => {
    if (!draftKey || typeof window === "undefined") return "";
    try { return localStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Per-turn toggle: should we attach a fresh iframe screenshot to this
  // send? Default on (mirrors prior behaviour). Resets to on after every
  // submit so a one-off skip doesn't silently disable the snapshot for the
  // rest of the session.
  const [includeCanvas, setIncludeCanvas] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showModelPicker = useModelPickerFlag();
  const [modelId, setModelId] = useState<string>(loadModelId);
  useEffect(() => { saveModelId(modelId); }, [modelId]);

  // Persist the draft. Empty drafts clear the key entirely so we don't
  // leave abandoned `""` rows in storage.
  useEffect(() => {
    if (!draftKey || typeof window === "undefined") return;
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch { /* ignore */ }
  }, [draftKey, text]);

  // When the active thread changes, swap the draft to that thread's saved value.
  useEffect(() => {
    if (!draftKey || typeof window === "undefined") return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(localStorage.getItem(draftKey) ?? "");
    } catch { /* ignore */ }
  }, [draftKey]);

  // One-shot seed from the edit-and-resubmit flow. Replaces the text +
  // focuses the textarea. Intentionally ignores seedText changes that
  // don't come with a fresh nonce so a re-render doesn't clobber edits.
  useEffect(() => {
    if (seedNonce === undefined || seedText === undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(seedText);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seedText.length, seedText.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

  // Canvas-drop bridge: a file row dropped onto the canvas dispatches
  // `cc-canvas-file-drop` with the project-relative path. Append it to
  // the composer the same way dropping on the textarea would.
  useEffect(() => {
    const onCanvasDrop = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (!path) return;
      setText((prev) => prev ? `${prev.replace(/\s+$/, "")} ${path} ` : `${path} `);
      requestAnimationFrame(() => ref.current?.focus());
    };
    window.addEventListener("cc-canvas-file-drop", onCanvasDrop);
    return () => window.removeEventListener("cc-canvas-file-drop", onCanvasDrop);
  }, []);

  // Auto-resize textarea up to 4 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [text]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const next = await Promise.all(
      list.map(
        (f) =>
          new Promise<Attachment>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve({ dataUrl: r.result as string, name: f.name || "pasted.png" });
            r.onerror = () => reject(r.error);
            r.readAsDataURL(f);
          })
      )
    );
    setAttachments((prev) => [...prev, ...next]);
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    // Intentionally NOT short-circuiting on `disabled`. When the active
    // turn is still streaming, the route's wrapped onSend stashes the
    // message in a one-slot queue (see QueuedBubble + the route-level
    // useEffect drain). Dropping the message here would silently lose
    // the user's input and risk a concurrent SDK turn squeaking through
    // a micro-window where `disabled` flips false between chunks.
    onSend(t, attachments, modelId, showCanvasToggle ? { includeCanvas } : undefined);
    setText("");
    setAttachments([]);
    // Reset the canvas toggle so the next turn re-includes the snapshot
    // by default. Sticky-off would silently strip context the user
    // probably forgot they disabled.
    setIncludeCanvas(true);
  };

  // Slash command popover. Opens when the composer text starts with "/" and
  // doesn't yet contain a space (i.e. user is still picking a command).
  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text.toLowerCase() : null;
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery))
    : [];
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => { setSlashIndex(0); }, [slashQuery]);
  const showSlash = slashMatches.length > 0;

  const runSlash = (cmd: SlashCommand) => {
    if (cmd.kind === "prompt") {
      onSend(cmd.prompt, [], modelId);
      setText("");
      setAttachments([]);
      return;
    }
    onSlashAction?.(cmd.action);
    setText("");
  };

  return (
    <form
      className={`${s.composer} ${dragOver ? s.composerDrag : ""}`}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) { await addFiles(e.dataTransfer.files); return; }
        // A row dragged from the file panels carries the project-relative
        // path on a custom MIME. Append it to the composer text so the AI
        // sees the reference; the user can then add a question around it.
        const filePath = e.dataTransfer.getData("application/x-cc-file-path");
        if (filePath) {
          setText((prev) => prev ? `${prev.replace(/\s+$/, "")} ${filePath} ` : `${filePath} `);
        }
      }}
    >
      {showSlash && (
        <div className={s.slashMenu} role="listbox">
          {slashMatches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === slashIndex}
              className={`${s.slashItem} ${i === slashIndex ? s.slashItemActive : ""}`}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => runSlash(c)}
            >
              <span className={s.slashName}>{c.name}</span>
              <span className={s.slashDesc}>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {(contextLabel || showCanvasToggle) && (
        <div className={s.contextRow}>
          {contextLabel && (
            <div className={s.contextPill} title="Context attached to the next turn">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 2 L11 2 L13 4 V14 H3 V4 L5 2 Z" />
                <path d="M6 6 H10 M6 9 H10" />
              </svg>
              <span>{contextLabel}</span>
              {onClearContext && (
                <button
                  type="button"
                  className={s.contextPillRemove}
                  onClick={onClearContext}
                  aria-label="Drop the selected element from this turn"
                  title="Drop the selected element from this turn"
                >×</button>
              )}
            </div>
          )}
          {showCanvasToggle && (
            includeCanvas ? (
              <div className={s.contextPill} title="A screenshot of the current canvas will be attached. Click × to send without it.">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="3" width="12" height="10" rx="2" />
                  <circle cx="8" cy="8" r="2.5" />
                </svg>
                <span>Current view</span>
                <button
                  type="button"
                  className={s.contextPillRemove}
                  onClick={() => setIncludeCanvas(false)}
                  aria-label="Don't attach a snapshot for this turn"
                >×</button>
              </div>
            ) : (
              <button
                type="button"
                className={s.contextPillAdd}
                onClick={() => setIncludeCanvas(true)}
                title="Attach a screenshot of the current canvas to this turn"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="3" width="12" height="10" rx="2" />
                  <circle cx="8" cy="8" r="2.5" />
                </svg>
                <span>+ snapshot</span>
              </button>
            )
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className={s.composerAttaches}>
          {attachments.map((a, i) => (
            <div key={i} className={s.composerAttachItem}>
              <img src={a.dataUrl} alt={a.name} />
              <button
                type="button"
                className={s.composerAttachRemove}
                onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                aria-label="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className={s.composerField}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={async (e) => {
          const items = Array.from(e.clipboardData.items).filter((it) => it.type.startsWith("image/"));
          if (items.length === 0) return;
          e.preventDefault();
          const files = items.map((it) => it.getAsFile()).filter((f): f is File => f != null);
          if (files.length) await addFiles(files);
        }}
        onKeyDown={(e) => {
          if (showSlash) {
            if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1)); return; }
            if (e.key === "ArrowUp")   { e.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return; }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSlash(slashMatches[slashIndex]); return; }
            if (e.key === "Escape") { e.preventDefault(); setText(""); return; }
            if (e.key === "Tab") { e.preventDefault(); setText(slashMatches[slashIndex].name + " "); return; }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={
          disabled
            ? hasQueued
              ? "1 queued — typing replaces it"
              : "Reply will queue · sent when current turn ends"
            : "Reply to thread · paste or drop to attach"
        }
        rows={1}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          if (e.target.files?.length) await addFiles(e.target.files);
          // Reset so re-picking the same file fires a fresh change event.
          e.target.value = "";
        }}
      />
      <div className={s.composerActions}>
        <div className={s.composerLeft}>
          <button
            type="button"
            className={s.composerAttachBtn}
            onClick={() => fileInputRef.current?.click()}
            title="Attach images"
            aria-label="Attach images"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11.5 4.5 L5.8 10.2 a2.2 2.2 0 0 0 3.1 3.1 L13 9.2 a3.8 3.8 0 0 0 -5.4 -5.4 L3.4 8 a5.4 5.4 0 0 0 7.6 7.6" />
            </svg>
          </button>
          {showModelPicker && (
            <ModelPicker value={modelId} onChange={setModelId} />
          )}
        </div>
        {disabled && onStop ? (
          <button
            type="button"
            className={s.composerStop}
            onClick={onStop}
            title="Stop the in-flight reply"
            aria-label="Stop"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <rect width="11" height="11" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className={s.composerSend}
            disabled={!text.trim()}
            title={
              disabled
                ? hasQueued
                  ? "Replace queued message · fires when current turn ends"
                  : "Queue this message · fires when current turn ends"
                : "Enter to send · Shift+Enter for newline"
            }
          >
            ↑
          </button>
        )}
      </div>
    </form>
  );
}



function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Bubble shown above the composer when the user typed a message while
 *  the active turn was still streaming. The route holds the message in
 *  a one-slot queue and auto-fires it once the turn drains; this UI
 *  makes the queued state visible and lets the user cancel it. */
function QueuedBubble({
  message,
  onCancel,
}: {
  message: QueuedMessage;
  onCancel: () => void;
}) {
  return (
    <div className={s.queuedBubble} role="status" aria-live="polite">
      <span className={s.queuedTag}>queued</span>
      <span className={s.queuedText} title={message.text}>{message.text}</span>
      <button
        type="button"
        className={s.queuedCancel}
        onClick={onCancel}
        title="Cancel queued message"
        aria-label="Cancel queued message"
      >×</button>
    </div>
  );
}

/** Re-exported so non-sidebar surfaces (the onboarding full-page chat)
 *  can render the same bubbles + composer without forking the markup. */
export { ChatBody, Composer, QueuedBubble };

/** Designer-flavoured starter prompts shown on an empty thread. Click a
 *  chip to send it as the first message. Curated to be useful for the
 *  banner / titling-system kind of work this editor is built for. */
const STARTER_PROMPTS: Array<{ short: string; full: string }> = [
  // Artifact-type starters for fresh / empty projects — clicking one
  // becomes the user's first message and Claude reads the intake brief
  // (rides as a hidden preamble) + the chosen artifact and runs intake.
  { short: "Lower third / overlay", full: "Help me build a lower third / video overlay." },
  { short: "Thumbnail", full: "Help me build a YouTube / video thumbnail." },
  { short: "Banner or poster", full: "Help me design a banner or poster." },
  { short: "Brand asset", full: "Help me design a brand asset (logo, identity card, etc.)." },
  // Refinement starters for existing projects — useful once there's
  // a real artifact on the canvas.
  { short: "Critique the active page", full: "Look at the active page and give me a sharp design critique. Three concrete things to improve, ordered by impact. No fluff." },
  { short: "Try a bolder type direction", full: "Propose a bolder typography direction for the active page — pair, scale, weights. Show the change as a rough sketch in source." },
];

/** Slash commands available from the composer. Typing `/` opens a
 *  popover; click or hit Enter to execute. Each command resolves either
 *  to a prompt (sent as a turn) or an action (handler runs synchronously). */
type SlashCommand =
  | { name: string; description: string; kind: "prompt"; prompt: string }
  | { name: string; description: string; kind: "action"; action: "new-thread" | "clear" | "copy" };

const SLASH_COMMANDS: SlashCommand[] = [
  // Slash-command prompts inlined (no longer indexed into STARTER_PROMPTS
  // — the chip list now leads with artifact-type starters for fresh
  // projects, so the index-based binding would silently misroute).
  { name: "/critique", description: "Sharp design critique, three things to improve", kind: "prompt", prompt: "Look at the active page and give me a sharp design critique. Three concrete things to improve, ordered by impact. No fluff." },
  { name: "/type", description: "Propose a bolder typography direction", kind: "prompt", prompt: "Propose a bolder typography direction for the active page — pair, scale, weights. Show the change as a rough sketch in source." },
  { name: "/responsive", description: "Make the active page responsive", kind: "prompt", prompt: "Make the active page responsive across desktop / tablet / mobile. Touch only the page's CSS." },
  { name: "/copy-content", description: "Replace placeholder copy with editorial-quality text", kind: "prompt", prompt: "Replace the placeholder copy on the active page with editorial-quality content. Don't change layout." },
  { name: "/plan", description: "Plan the change before editing — files, diffs, visual goal", kind: "prompt", prompt: "Before doing it, write me a plan: list the files you'll touch, the changes per file, and the visual goal. Don't edit yet." },
  { name: "/diff", description: "Summarize the most recent edits this turn made", kind: "prompt", prompt: "Summarize the most recent edits — list each file changed and the gist of what changed." },
  { name: "/screenshot", description: "Take a fresh screenshot of the active page", kind: "prompt", prompt: "Take a fresh screenshot of the active page so you can see the current state." },
  { name: "/export", description: "Export the selected element — picks PNG / JPEG / OGraf", kind: "prompt", prompt: "Use the export skill on the currently selected element. If the format isn't obvious from what I've said, ask me with a single mcp__ask-user__ask_user enum question whether I want PNG (transparent), JPEG (smaller), or OGraf (Resolve 21+). Otherwise just call the right capability and tell me what you saved." },
  { name: "/explain", description: "Walk through what's currently on the active page", kind: "prompt", prompt: "Walk me through what's currently on the active page — components, layout decisions, design choices." },
  { name: "/refactor", description: "Refactor the active component without changing visuals", kind: "prompt", prompt: "Refactor the active component for cleaner structure without changing the visual output." },
  { name: "/test", description: "Suggest a small test for the most recent change", kind: "prompt", prompt: "Suggest a small test or visual sanity check for the most recent change." },
  { name: "/new", description: "Start a new chat thread", kind: "action", action: "new-thread" },
  { name: "/clear", description: "Clear all messages in this thread", kind: "action", action: "clear" },
  { name: "/copy", description: "Copy this thread to clipboard as plain text", kind: "action", action: "copy" },
];

function ChatBody({
  thread,
  threadId,
  onUndo,
  onRetry,
  onDeleteMessage,
  onRestore,
  onSendStarter,
  onEditMessage,
}: {
  thread: ChatThread | null;
  threadId: string;
  onUndo: (turnId: string) => void;
  onRetry: (threadId: string, userIndex: number) => void;
  onDeleteMessage: (threadId: string, index: number) => void;
  onRestore?: (m: Extract<ChatMessage, { role: "user" }>) => void;
  /** Click on a starter chip → fire this prompt as a turn. */
  onSendStarter?: (text: string) => void;
  /** Pencil on a user bubble → truncate from here + drop text into composer. */
  onEditMessage?: (threadId: string, index: number, text: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Scroll to bottom when new messages arrive or content changes (streaming).
  useEffect(() => {
    if (!autoScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread?.messages.length, thread?.messages.at(-1)?.content, autoScroll]);

  // Detect manual scroll to disable auto-scroll when user scrolls up.
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  };

  // Filter out hidden messages (e.g. the onboarding intake prompt — it's
  // for Claude, not for the user to read). The original index is kept on
  // each entry so Bubble can still resolve into the unfiltered messages
  // array for retry/delete/etc.
  const visible = thread?.messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !(m.role === "user" && m.hidden)) ?? [];

  // Special case for the onboarding flow: if everything visible is the
  // pending assistant of the very first turn (i.e. user only sent a
  // hidden intake), show a calm "Starting…" indicator instead of an
  // empty bubble that looks broken. Model-agnostic — projects can use
  // any provider (Claude, Kimi, etc.) so we don't name one here.
  const isStartingFirstTurn =
    visible.length === 1 &&
    visible[0].m.role === "assistant" &&
    !!visible[0].m.pending &&
    visible[0].m.content.length === 0 &&
    visible[0].m.tools.length === 0;

  return (
    <div className={s.body} ref={bodyRef} onScroll={onScroll}>
      {!thread || visible.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className={s.emptyTitle}>What are we making?</div>
          <div className={s.emptyText}>
            Tell me what you want to build, or pick a starting point below.
          </div>
          {onSendStarter && (
            <div className={s.starterGrid}>
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p.short}
                  type="button"
                  className={s.starterChip}
                  onClick={() => onSendStarter(p.full)}
                  title={p.full}
                >
                  {p.short}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : isStartingFirstTurn ? (
        <div className={s.empty}>
          <div className={s.streamingDots}>
            <span /><span /><span />
          </div>
          <div className={s.emptyTitle}>Starting…</div>
          <div className={s.emptyText}>
            Setting up the conversation. The first question will appear in a moment.
          </div>
        </div>
      ) : (
        visible.map(({ m, i }) => (
          <Bubble
            key={i}
            m={m}
            index={i}
            messages={thread!.messages}
            threadId={threadId}
            onUndo={onUndo}
            onRetry={onRetry}
            onDeleteMessage={onDeleteMessage}
            onRestore={onRestore}
            onEditMessage={onEditMessage}
          />
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function AssistantLabel({ messages, index }: { messages: ChatMessage[]; index: number }) {
  // Look back for the preceding user message to find which model was used.
  for (let i = index - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && msg.modelId) {
      const model = getModel(msg.modelId);
      if (model) return <span className={s.assistantLabel}>{model.label}</span>;
    }
  }
  return <span className={s.assistantLabel}>AI</span>;
}

/** Compact "tokens · duration · model" footer rendered under the
 *  assistant timestamp once the turn is finished. We pull live usage off
 *  the chatStream module's accumulated state — that way the chat
 *  message itself stays untouched (Editor owns the message shape) and
 *  the badge degrades gracefully when no usage info is available
 *  (older threads, non-SDK providers, kimi). */
function CostBadge({ messages, index }: { messages: ChatMessage[]; index: number }) {
  // Look back for the user message that started this turn — its
  // streamId points at the live (or recently-finished) stream entry,
  // and its modelId resolves to the human-readable model label.
  let userMsg: Extract<ChatMessage, { role: "user" }> | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") { userMsg = m; break; }
  }

  const usage: TurnUsage | undefined =
    userMsg?.streamId ? getStreamState(userMsg.streamId)?.usage : undefined;

  // Friendly model label: prefer the user's selected model id (always
  // present), fall back to the SDK-reported model when the user picker
  // wasn't shown (matches AssistantLabel's lookup).
  const modelLabel = (() => {
    if (userMsg?.modelId) {
      const m = getModel(userMsg.modelId);
      if (m) return m.label;
    }
    return usage?.model;
  })();

  if (!modelLabel && !usage) return null;

  const parts: string[] = [];
  if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
    const inT = formatTokenCount(
      // Total input cost = fresh input + cache-creation + cache-read.
      // Reads are cheaper but still count as context; surfacing them
      // gives the user a fair sense of "how big was this turn".
      (usage.inputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0),
    );
    const outT = formatTokenCount(usage.outputTokens ?? 0);
    parts.push(`${inT} → ${outT} tokens`);
  }
  if (usage?.durationMs != null) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  if (modelLabel) parts.push(modelLabel);
  if (parts.length === 0) return null;

  return <div className={s.costBadge}>{parts.join(" · ")}</div>;
}

/** Format token counts compactly: 2398 → "2.4k", 312 → "312". */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return Math.round(n / 1000) + "k";
}

function Bubble({
  m,
  index,
  messages,
  threadId,
  onUndo,
  onRetry,
  onDeleteMessage,
  onRestore,
  onEditMessage,
}: {
  m: ChatMessage;
  index: number;
  messages: ChatMessage[];
  threadId: string;
  onUndo: (turnId: string) => void;
  onRetry: (threadId: string, userIndex: number) => void;
  onDeleteMessage: (threadId: string, index: number) => void;
  onRestore?: (m: Extract<ChatMessage, { role: "user" }>) => void;
  /** Click pencil → drop the user message + everything after into the
   *  composer for editing. Truncates the thread from this index. */
  onEditMessage?: (threadId: string, index: number, text: string) => void;
}) {
  // Local lightbox state — clicking the user-bubble thumbnail opens
  // the full image in an Esc/click-out dismissable overlay.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const lightbox = lightboxSrc ? (
    <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
  ) : null;

  if (m.role === "user") {
    const tag = m.tag ?? "el";
    const snippet = m.innerText?.trim();
    // Prefer the rich descriptor when present — it gives the user a
    // verifiable preview of what context the AI received ("h1.title
    // 'Welcome' inside section.hero" vs just "<h1>"). Falls back to
    // the legacy tag + innerText pair for older messages.
    const desc = m.descriptor;
    return (
      <div className={`${s.row} ${s.rowUser}`}>
        <div className={s.bubbleUser}>
          {(m.thumbnail || m.selector) && (
            <div className={s.refRow}>
              {m.thumbnail && (
                <button
                  type="button"
                  className={s.refThumbBtn}
                  onClick={() => setLightboxSrc(m.thumbnail ?? null)}
                  title="Click to view full size"
                  aria-label="Open image"
                >
                  <img className={s.refThumb} src={m.thumbnail} alt="" loading="lazy" />
                </button>
              )}
              <div className={s.refLabel}>
                {desc ? (
                  <span
                    className={s.refSnippet}
                    title={desc.ancestors.length > 1 ? `ancestors: ${desc.ancestors.join(" › ")}` : undefined}
                  >
                    {desc.label}
                  </span>
                ) : (
                  <>
                    <span className={s.refTag}>&lt;{tag}&gt;</span>
                    {snippet ? (
                      <span className={s.refSnippet}>"{snippet.length > 36 ? snippet.slice(0, 33) + "…" : snippet}"</span>
                    ) : (
                      <code className={s.refPath}>{m.route}</code>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {m.attachments && m.attachments.length > 0 && (
            <div className={s.bubbleAttaches}>
              {m.attachments.map((a, i) => (
                <a
                  key={i}
                  className={s.bubbleAttachItem}
                  href={a.dataUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={a.name}
                >
                  <img src={a.dataUrl} alt={a.name} loading="lazy" />
                </a>
              ))}
            </div>
          )}
          <div className={s.text}>{m.content}</div>
          <div className={s.bubbleActionsRight}>
            {m.domHtml && onRestore && (
              <button className={s.restoreBtn} onClick={() => onRestore(m)} title="Restore the iframe to how it looked at this comment">
                ↺ Restore
              </button>
            )}
            {onEditMessage && (
              <button
                className={s.deleteMsgBtn}
                onClick={() => onEditMessage(threadId, index, m.content)}
                title="Edit and resend (truncates the thread from here)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 4 L20 10 L8 22 H2 V16 Z" />
                </svg>
              </button>
            )}
            <button
              className={s.deleteMsgBtn}
              onClick={() => onDeleteMessage(threadId, index)}
              title="Delete this message and everything after it"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
          <div className={s.bubbleMetaRight}>{formatTime(m.ts)}</div>
        </div>
        {lightbox}
      </div>
    );
  }

  const copyContent = async () => {
    try { await navigator.clipboard.writeText(m.content); } catch { /* ignore */ }
  };

  // Find the preceding user message index for retry
  const prevUserIndex = (() => {
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  })();

  return (
    <div className={`${s.row} ${s.rowAssistant}`}>
      <div className={s.assistantMeta}>
        <div className={s.assistantAvatar}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="8" y1="22" x2="16" y2="22" />
          </svg>
        </div>
        <AssistantLabel messages={messages} index={index} />
      </div>
      <div className={s.bubbleAssistant}>
        {m.thinking && (
          <ThinkingBlock text={m.thinking} pending={!!m.pending} />
        )}
        {/* Visual hierarchy: the model's prose is the *headline*. Tool
         *  chips and any rendered artifacts sit below as subordinate
         *  detail. Earlier this was inverted (chips dominated the
         *  bubble, the prose was a tiny line at the bottom) and the UI
         *  felt like a build log instead of a conversation.
         *
         *  When pending AND no text has streamed yet, we show a live
         *  status line ("Reading X…") so the user always sees forward
         *  motion — without it the bubble shows just dots + tool chips
         *  and feels frozen. */}
        {m.error ? (
          <div className={s.errText}>⚠ {m.error}</div>
        ) : (
          <div className={s.text}>
            {m.content ? (
              <Markdown text={m.content} />
            ) : m.pending ? (
              <LiveStatus tools={m.tools} />
            ) : (
              <span className={s.dim}>(no response)</span>
            )}
            {m.pending && m.content && <span className={s.caret} />}
          </div>
        )}
        {/* Artifacts (real visual outputs from export tools) stay
         *  prominent — the user wants to *see* what was rendered. */}
        {m.tools.map((t, i) => {
          const a = parseArtifact(t.result);
          return a ? <ArtifactCard key={`art-${i}`} artifact={a} /> : null;
        })}
        {/* Tool chips: collapsed-by-default footer when there are >2
         *  calls AFTER the turn finishes; while pending we always
         *  expand so the user sees chips appearing live as the model
         *  works. */}
        {m.tools.length > 0 && (
          <ToolFooter tools={m.tools} pending={!!m.pending} />
        )}
        {!m.pending && (
          <div className={s.bubbleActions}>
            {m.error && prevUserIndex >= 0 && (
              <button
                className={s.retryBtn}
                onClick={() => onRetry(threadId, prevUserIndex)}
                title="Retry this turn with the same model"
              >
                ↻ Retry
              </button>
            )}
            {!m.error && m.turnId && (
              <>
                {m.reverted ? (
                  <span className={s.revertedTag}>↩ Reverted</span>
                ) : (
                  <button className={s.undoBtn} onClick={() => m.turnId && onUndo(m.turnId)} title="Restore the files this turn changed">
                    ↩ Undo
                  </button>
                )}
              </>
            )}
            <button className={s.copyBtn} onClick={copyContent} title="Copy response">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className={s.bubbleMetaLeft}>
        {formatTime(m.ts)}
        {!m.pending && !m.error && (
          <CostBadge messages={messages} index={index} />
        )}
      </div>
    </div>
  );
}

function StreamingDots() {
  return (
    <div className={s.streamingDots}>
      <span />
      <span />
      <span />
    </div>
  );
}

/** Collapsible reasoning block. Auto-collapsed once the reply text starts
 *  arriving (so the final answer is the focal point); auto-open while the
 *  model is still thinking and there's no text yet. */
function ThinkingBlock({ text, pending }: { text: string; pending: boolean }) {
  const [open, setOpen] = useState(pending);
  return (
    <details
      className={s.thinkingBlock}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={s.thinkingSummary}>
        {pending ? "Thinking…" : "Thought process"}
      </summary>
      <div className={s.thinkingBody}>{text}</div>
    </details>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function pickFilePath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const p = input.file_path ?? input.path ?? input.file;
  return typeof p === "string" ? p : undefined;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Subordinate-by-default tool footer.
 *
 *  • While `pending` (turn still in flight): always render chips
 *    expanded, regardless of count. The user needs to see chips
 *    appearing one-by-one to know the model is making forward progress.
 *  • Once the turn finishes:
 *      - 1–2 calls → small inline pills beneath the prose
 *      - 3+ calls  → collapsed "N steps · file, file +rest" summary
 *
 *  This is what makes the bubble feel like a conversation: the AI's
 *  prose is the headline, "what I did" is a subtle footer the user can
 *  drill into if they're curious — but during the work itself, every
 *  tool call is visible feedback that something is happening. */
function ToolFooter({ tools, pending }: { tools: ToolCall[]; pending: boolean }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  // Pending OR few tools: always expanded.
  const expanded = pending || tools.length <= 2 || open;
  if (pending || tools.length <= 2) {
    return (
      <div className={s.tools} data-compact={tools.length <= 2 ? "true" : "false"}>
        {tools.map((t, i) => <ToolChip key={i} tool={t} />)}
      </div>
    );
  }
  // Done + 3+ tools: collapsible summary footer.
  const fileSet = new Set<string>();
  for (const t of tools) {
    const m = (t.label || "").match(/·\s+(.+)/);
    if (m && m[1]) fileSet.add(m[1].trim());
  }
  const files = Array.from(fileSet);
  const summary = files.length > 0
    ? `${tools.length} steps · ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` +${files.length - 2}` : ""}`
    : `${tools.length} steps`;
  return (
    <div className={s.toolFooter}>
      <button
        type="button"
        className={s.toolFooterToggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        title={expanded ? "Collapse steps" : "Show all steps"}
      >
        <span>{expanded ? "Hide steps" : summary}</span>
        <span className={s.toolFooterChev} aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>
      {expanded && (
        <div className={s.tools} data-compact="false">
          {tools.map((t, i) => <ToolChip key={i} tool={t} />)}
        </div>
      )}
    </div>
  );
}

/** Live status while the assistant is pending and no text has streamed
 *  yet. Mirrors the latest tool's label ("Reading RouteMap.jsx") above
 *  the streaming dots, so the user always knows what the model is
 *  doing right now even when it hasn't yet sent prose. As soon as text
 *  starts streaming, this gets replaced by the actual content (handled
 *  by the parent's m.content check). */
function LiveStatus({ tools }: { tools: ToolCall[] }) {
  const last = tools.length > 0 ? tools[tools.length - 1] : null;
  // Map common tool names to a verb the user understands.
  let verb = "Working";
  let target = "";
  if (last) {
    const label = last.label || last.tool || "";
    const m = label.match(/^(\w+)\s*·\s*(.+)$/);
    if (m) {
      const [, name, file] = m;
      target = file.trim();
      const v = name.toLowerCase();
      if (v.startsWith("read")) verb = "Reading";
      else if (v.startsWith("edit") || v.startsWith("strreplace") || v.startsWith("write")) verb = "Editing";
      else if (v.startsWith("grep") || v.startsWith("search")) verb = "Searching";
      else if (v.startsWith("glob")) verb = "Looking through";
      else if (v.startsWith("bash") || v.startsWith("shell")) verb = "Running";
      else verb = name;
    } else {
      verb = label || "Working";
    }
  }
  return (
    <div className={s.liveStatus}>
      <StreamingDots />
      <span className={s.liveStatusLabel}>
        {target ? `${verb} ${target}…` : "Thinking…"}
      </span>
    </div>
  );
}

/** Expandable tool-call chip: collapsed it looks like the old pill
 *  ("Read · index.html"); clicked, it opens an accordion panel showing
 *  the tool's input — file paths, diffs, commands, image previews. */
function ToolChip({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!tool.input && Object.keys(tool.input).length > 0;
  return (
    <div className={`${s.toolChipWrap} ${open ? s.toolChipOpen : ""}`}>
      <button
        type="button"
        className={s.toolChip}
        onClick={() => hasDetails && setOpen((o) => !o)}
        disabled={!hasDetails}
        aria-expanded={open}
        title={hasDetails ? (open ? "Hide details" : "Show details") : undefined}
      >
        <span>{tool.label}</span>
        {hasDetails && <span className={s.toolChipChev} aria-hidden="true">▾</span>}
      </button>
      {open && hasDetails && (
        <div className={s.toolDetail}>
          <ToolDetail tool={tool} />
          {typeof tool.result === "string" && tool.result.length > 0 && (
            <ToolResultBlock result={tool.result} isError={tool.isError} />
          )}
        </div>
      )}
    </div>
  );
}

/** Collapsed-by-default panel showing the SDK's `tool_result` text — file
 *  contents from a Read, grep matches, bash output, etc. Long results
 *  preview the first ~16 lines and reveal the rest behind "Show all". */
function ToolResultBlock({ result, isError }: { result: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = result.split("\n");
  const PREVIEW_LINES = 16;
  const truncated = lines.length > PREVIEW_LINES;
  const shown = expanded || !truncated ? result : lines.slice(0, PREVIEW_LINES).join("\n");
  return (
    <CodeBlock
      label={isError ? "Error" : "Result"}
      code={shown + (truncated && !expanded ? `\n… ${lines.length - PREVIEW_LINES} more lines` : "")}
      flavor={isError ? "del" : undefined}
      action={truncated ? { label: expanded ? "Show less" : "Show all", onClick: () => setExpanded((x) => !x) } : undefined}
    />
  );
}

function ToolDetail({ tool }: { tool: ToolCall }) {
  const input = tool.input ?? {};
  const filePath = pickFilePath(input);
  const name = tool.name;

  // Read — show the file path; if it's an image, render an inline preview.
  if (name === "Read" && filePath) {
    const isImage = IMAGE_EXT.test(filePath);
    return (
      <>
        <DetailRow label="File" value={filePath} mono />
        {typeof input.offset === "number" && (
          <DetailRow label="Offset" value={String(input.offset)} mono />
        )}
        {typeof input.limit === "number" && (
          <DetailRow label="Limit" value={String(input.limit)} mono />
        )}
        {isImage && (
          <div className={s.toolImageWrap}>
            <img
              className={s.toolImage}
              src={`/api/tool-image?path=${encodeURIComponent(filePath)}`}
              alt={basename(filePath)}
              loading="lazy"
              onError={(e) => {
                const el = e.currentTarget;
                el.style.display = "none";
                const note = el.nextElementSibling as HTMLElement | null;
                if (note) note.style.display = "block";
              }}
            />
            <div className={s.toolImageMissing} style={{ display: "none" }}>
              Preview unavailable
            </div>
          </div>
        )}
      </>
    );
  }

  // Edit / MultiEdit — render a unified diff (GitHub-style) for each
  // {old_string, new_string} pair so additions and removals share a single
  // panel with line numbers instead of two separate boxes.
  if ((name === "Edit" || name === "MultiEdit") && filePath) {
    const edits: Array<{ oldStr: string; newStr: string }> = [];
    if (typeof input.old_string === "string" && typeof input.new_string === "string") {
      edits.push({ oldStr: input.old_string, newStr: input.new_string });
    }
    if (Array.isArray(input.edits)) {
      for (const e of input.edits as Array<Record<string, unknown>>) {
        if (typeof e?.old_string === "string" && typeof e?.new_string === "string") {
          edits.push({ oldStr: e.old_string as string, newStr: e.new_string as string });
        }
      }
    }
    return (
      <>
        <DetailRow label="File" value={filePath} mono />
        {edits.length > 0
          ? edits.map((e, i) => (
              <DiffBlock key={i} oldText={e.oldStr} newText={e.newStr} filename={filePath} />
            ))
          : <CodeBlock label="Input" code={JSON.stringify(input, null, 2)} />}
      </>
    );
  }

  // Write / NotebookEdit — file plus the new content.
  if ((name === "Write" || name === "NotebookEdit") && filePath) {
    const content = typeof input.content === "string" ? input.content : undefined;
    return (
      <>
        <DetailRow label="File" value={filePath} mono />
        {content !== undefined && <CodeBlock label="Content" code={content} flavor="add" />}
      </>
    );
  }

  // Bash — show the command (and optional description).
  if (name === "Bash" && typeof input.command === "string") {
    return (
      <>
        {typeof input.description === "string" && (
          <DetailRow label="Description" value={input.description} />
        )}
        <CodeBlock label="Command" code={input.command} mono />
      </>
    );
  }

  // Glob / Grep — pattern + path.
  if ((name === "Glob" || name === "Grep") && typeof input.pattern === "string") {
    return (
      <>
        <DetailRow label="Pattern" value={input.pattern} mono />
        {typeof input.path === "string" && <DetailRow label="Path" value={input.path} mono />}
        {typeof input.glob === "string" && <DetailRow label="Glob" value={input.glob} mono />}
      </>
    );
  }

  // Fallback — pretty-print the raw input so nothing important is hidden.
  return <CodeBlock label="Input" code={JSON.stringify(input, null, 2)} />;
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={s.toolDetailRow}>
      <span className={s.toolDetailLabel}>{label}</span>
      <span className={`${s.toolDetailValue} ${mono ? s.toolDetailMono : ""}`}>{value}</span>
    </div>
  );
}

function CodeBlock({
  label,
  code,
  flavor,
  mono,
  action,
}: {
  label: string;
  code: string;
  flavor?: "add" | "del";
  mono?: boolean;
  /** Optional inline button rendered next to the label (e.g. "Show all"). */
  action?: { label: string; onClick: () => void };
}) {
  const cls = `${s.toolCode} ${flavor === "add" ? s.toolCodeAdd : ""} ${flavor === "del" ? s.toolCodeDel : ""} ${mono ? s.toolCodeMono : ""}`;
  return (
    <div className={s.toolCodeBlock}>
      <div className={s.toolCodeBlockLabelRow}>
        <span className={s.toolDetailLabel}>{label}</span>
        {action && (
          <button type="button" className={s.toolCodeBlockAction} onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      <pre className={cls}>{code}</pre>
    </div>
  );
}
