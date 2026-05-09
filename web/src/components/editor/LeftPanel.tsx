/* LeftPanel — unified left rail with tabs for everything except the
 * style inspector. Tabs: Chat, Comments. The right side stays
 * dedicated to the inspector when in Edit mode.
 *
 * Collapse persists across reloads under "left-panel-collapsed". When
 * the parent bumps `chatTabSwitchKey`, this component switches to the
 * Chat tab and uncollapses if needed (used after the intake flow on a
 * fresh project, and when the user clicks "Ask AI" on a comment).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import s from "./leftPanel.module.css";
import { ChatTab, type ChatThread, type QueuedMessage } from "./ChatSidebar";
import { CommentsPanel } from "./CommentsPanel";
import { useComments, type LocalComment } from "../../lib/comments";
import type { Attachment } from "./CommentBubble";
import type { ElicitRequest } from "../../lib/chatStream";

type Tab = "chat" | "comments";

const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 720;
const PANEL_DEFAULT_WIDTH = 380;
const PANEL_WIDTH_LEGACY_KEY = "left-panel-width";
const panelWidthKey = (projectId: string) => `left-panel-width:${projectId}`;

function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return PANEL_DEFAULT_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, w));
}

function readStoredPanelWidth(projectId: string): number {
  if (typeof window === "undefined") return PANEL_DEFAULT_WIDTH;
  try {
    // Per-project key first; fall back to the pre-2026 single-key value
    // so users who already had a preferred width don't get reset.
    const raw =
      localStorage.getItem(panelWidthKey(projectId)) ??
      localStorage.getItem(PANEL_WIDTH_LEGACY_KEY);
    if (!raw) return PANEL_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return PANEL_DEFAULT_WIDTH;
    return clampPanelWidth(n);
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

type Props = {
  projectId: string;

  /* Chat tab */
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
  onRestore?: (m: Extract<ChatThread["messages"][number], { role: "user" }>) => void;
  pendingElicit?: ElicitRequest | null;
  onElicitResolved?: (echoText: string | null) => void;
  /** True while the agent has called ask_user but the form schema
   *  hasn't arrived yet — shows a "Generating questions…" indicator. */
  elicitBuilding?: boolean;
  onStop?: () => void;
  /** A message held until the active turn drains. Rendered above the
   *  composer as a dimmer "queued" bubble. See route-level queueOrSend. */
  queuedMessage?: QueuedMessage | null;
  onCancelQueued?: () => void;

  /* Comments tab */
  activeFile: string;
  selectedPinId: string | null;
  onSelectPin: (id: string | null) => void;
  /** Multi-select promotion entry-point. Replaces the legacy
   *  onPromoteComment. The route owns prompt-bundling + payload
   *  assembly + queueOrSend dispatch. */
  onPromoteComments: (comments: LocalComment[], modelId: string, mode: "active" | "new" | "queue") => void;
  onRestoreComment?: (c: LocalComment) => void;
  /** Best-effort screenshot of the current iframe view, used by the
   *  panel's free-form composer (file-level notes). */
  captureRouteScreenshot?: () => Promise<string | undefined>;
  /** Comment ids the parent has just-promoted, awaiting the user's
   *  one-click "resolve N?" confirmation strip after stream success. */
  autoResolvePromptIds?: string[];
  onAutoResolveConfirm?: (ids: string[]) => void;
  onAutoResolveDismiss?: () => void;

  /** Bumping this value force-switches the panel to the Chat tab and
   *  uncollapses it. Used after the intake-prompt for a fresh project. */
  chatTabSwitchKey?: number;

  /** Optional human label for what context the next composer turn will
   *  carry (file name + selected element). Rendered above the textarea
   *  so the user can see what Claude will see. */
  composerContext?: string;
  /** Drop the picked element from the next turn — wired to an × on the
   *  context pill above the composer. */
  onClearComposerContext?: () => void;

  /** When true, the project hasn't produced any real files yet. Render
   *  the panel as the centerpiece: locked to the chat tab, no Files /
   *  Layers / Comments tabs, no resizer, much wider — the canvas + tool
   *  chrome are hidden by the parent so this becomes a focused intake
   *  conversation. Flips false the moment Claude writes the first file. */
  emptyState?: boolean;

  /** Open Settings to the Skills section. Threaded into ChatTab so the
   *  ActiveSkillsStrip rendered above the composer can route its click
   *  to the right surface. Optional — Onboard / other surfaces without
   *  a Settings dialog can omit it; the strip falls back to a no-op. */
  onOpenSkillsSettings?: () => void;
};

export function LeftPanel(props: Props) {
  const {
    projectId,
    threads, activeThread, onNewThread, onSwitchThread, onDeleteThread,
    onRenameThread, onUndo, onRetry, onDeleteMessage, onSend, onRestore,
    pendingElicit, onElicitResolved, elicitBuilding, onStop,
    queuedMessage, onCancelQueued,
    activeFile, selectedPinId, onSelectPin, onPromoteComments, onRestoreComment,
    captureRouteScreenshot,
    autoResolvePromptIds, onAutoResolveConfirm, onAutoResolveDismiss,
    chatTabSwitchKey, composerContext, onClearComposerContext,
    emptyState, onOpenSkillsSettings,
  } = props;

  const [tab, setTab] = useState<Tab>("chat");
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("left-panel-collapsed") === "1";
  });

  // Resizable width state. The current width is held in React state so
  // the inline style stays in sync; the latest value also lives in a
  // ref so the mousemove handler doesn't need to be recreated each
  // pixel of motion (which would re-attach window listeners).
  const [width, setWidth] = useState<number>(() => readStoredPanelWidth(projectId));
  // When the active project changes, restore that project's stored width.
  useEffect(() => { setWidth(readStoredPanelWidth(projectId)); }, [projectId]);
  const widthRef = useRef<number>(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("left-panel-collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);

  // Cmd/Ctrl+B (in Editor.tsx) dispatches "leftpanel:toggle" so the
  // panel can flip its own collapsed state without prop-drilling.
  useEffect(() => {
    const onToggle = () => setCollapsed((v) => !v);
    window.addEventListener("leftpanel:toggle", onToggle);
    return () => window.removeEventListener("leftpanel:toggle", onToggle);
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only react to primary button. Right-/middle-click should fall
    // through to the browser's default context-menu / scroll behavior.
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    const onMove = (ev: MouseEvent) => {
      const next = clampPanelWidth(startWidth + (ev.clientX - startX));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("left-panel-resizing");
      setIsResizing(false);
      try {
        localStorage.setItem(panelWidthKey(projectId), String(Math.round(widthRef.current)));
      } catch { /* ignore */ }
    };

    document.body.classList.add("left-panel-resizing");
    setIsResizing(true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [projectId]);

  // If the component unmounts mid-drag, make sure we don't leave the
  // body class behind. (Handlers attached above are removed on mouseup
  // but a forced unmount would leak them.)
  useEffect(() => {
    return () => { document.body.classList.remove("left-panel-resizing"); };
  }, []);

  const handleResizeDoubleClick = useCallback(() => {
    setWidth(PANEL_DEFAULT_WIDTH);
    try {
      localStorage.setItem(panelWidthKey(projectId), String(PANEL_DEFAULT_WIDTH));
    } catch { /* ignore */ }
  }, [projectId]);

  // Parent force-switches to Chat by bumping chatTabSwitchKey.
  useEffect(() => {
    if (chatTabSwitchKey === undefined || chatTabSwitchKey === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab("chat");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(false);
  }, [chatTabSwitchKey]);

  const allComments = useComments(projectId);
  const openCommentCount = allComments.filter((c) => c.file === activeFile && !c.resolved).length;
  const threadCount = activeThread?.messages.length ?? 0;

  if (collapsed) {
    return (
      <button
        className={s.collapseHandle}
        onClick={() => setCollapsed(false)}
        title="Open panel"
      >
        ›
      </button>
    );
  }

  // emptyState is accepted but currently unused — the layout shift was
  // moved out of LeftPanel; the parent's `isEmptyProject` derivation
  // now drives chat copy + composer chips inside ChatTab/ChatBody, not
  // a panel-level layout override. Kept on the type so the call site
  // doesn't need to change again the next time we revisit this.
  void emptyState;

  return (
    <aside className={s.panel} style={{ width }}>
      <div
        className={`${s.resizeHandle} ${isResizing ? s.resizeHandleActive : ""}`}
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResizeDoubleClick}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left panel"
        title="Drag to resize. Double-click to reset."
      />
      <div className={s.head}>
        <div className={s.tabs}>
          <button
            className={`${s.tab} ${tab === "chat" ? s.tabActive : ""}`}
            onClick={() => setTab("chat")}
          >
            Chat
            {threadCount > 0 && <span className={s.tabBadge}>{threadCount}</span>}
          </button>
          <button
            className={`${s.tab} ${tab === "comments" ? s.tabActive : ""}`}
            onClick={() => setTab("comments")}
          >
            Comments
            {openCommentCount > 0 && <span className={s.tabBadge}>{openCommentCount}</span>}
          </button>
        </div>
        <button
          className={s.headIcon}
          onClick={() => setCollapsed(true)}
          title="Close panel"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>
      {tab === "chat" && (
        <ChatTab
          threads={threads}
          activeThread={activeThread}
          composerContext={composerContext}
          onClearComposerContext={onClearComposerContext}
          onNewThread={onNewThread}
          onSwitchThread={onSwitchThread}
          onDeleteThread={onDeleteThread}
          onRenameThread={onRenameThread}
          onUndo={onUndo}
          onRetry={onRetry}
          onDeleteMessage={onDeleteMessage}
          onSend={onSend}
          onRestore={onRestore}
          pendingElicit={pendingElicit}
          onElicitResolved={onElicitResolved}
          elicitBuilding={elicitBuilding}
          onStop={onStop}
          queuedMessage={queuedMessage}
          onCancelQueued={onCancelQueued}
          showCanvasToggle
          projectId={projectId}
          onOpenSkillsSettings={onOpenSkillsSettings}
        />
      )}
      {tab === "comments" && (
        <CommentsPanel
          projectId={projectId}
          file={activeFile}
          onSelectPin={onSelectPin}
          selectedPinId={selectedPinId}
          onPromoteComments={onPromoteComments}
          onRestore={onRestoreComment}
          hasActiveThread={!!activeThread}
          captureRouteScreenshot={captureRouteScreenshot}
          autoResolvePromptIds={autoResolvePromptIds}
          onAutoResolveConfirm={onAutoResolveConfirm}
          onAutoResolveDismiss={onAutoResolveDismiss}
        />
      )}
    </aside>
  );
}
