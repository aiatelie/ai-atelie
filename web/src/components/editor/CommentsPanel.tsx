/* CommentsPanel.tsx — local annotations for the active file.
 *
 * GitHub-PR-review-style comment workflow:
 *   1. Make comments freely (anchored from the iframe via CommentBubble,
 *      or file-level via the bottom CommentComposer).
 *   2. Multi-select rows in this panel.
 *   3. Promote the selection into a chat thread — one bundled message,
 *      one screenshot per comment, three target modes.
 *
 * The selection lives entirely in this component (the parent doesn't
 * care which rows are checked). Promotion delegates to the parent's
 * `onPromoteComments` prop, which builds the bundled prompt + payload
 * and routes through the same queueOrSend lock the composer uses.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import s from "./chat.module.css";
import {
  addComment,
  bulkResolve,
  removeComment,
  updateComment,
  useComments,
  type LocalComment,
} from "../../lib/comments";
import { smartLabel } from "../../lib/smartLabel";
import {
  ModelPicker,
  loadModelId,
  saveModelId,
  useModelPickerFlag,
} from "./ModelPicker";
import { EmptyState } from "../feedback";

/** Where to send the bundled selection.
 *   - "active" → append to the currently-active chat thread (or start
 *     one if none exists). Default primary action.
 *   - "new"    → spawn a new thread named after the first comment.
 *   - "queue"  → drop the bundle into the one-slot composer queue so it
 *     respects an in-flight turn. */
export type PromoteMode = "active" | "new" | "queue";

/** Filter chip identity. The "all-files" chip is independent — it's
 *  enforced by the parent via the `file` prop, but here we treat
 *  "all-files" as a fourth status that broadens the file scope. */
export type CommentFilter = "open" | "promoted" | "resolved" | "all-files";

type Props = {
  /** Active project — comments are scoped per project. */
  projectId: string;
  /** Active route — comments are scoped to this file unless the user
   *  picks the "All Files" chip. */
  file: string;
  /** Sync the iframe pin highlight with the panel selection. */
  onSelectPin: (id: string | null) => void;
  selectedPinId: string | null;
  /** Promote N comments to AI in one bundled turn. The parent does the
   *  prompt-building + payload assembly + queueOrSend dispatch. */
  onPromoteComments: (comments: LocalComment[], modelId: string, mode: PromoteMode) => void;
  /** Restore the iframe to the DOM snapshot saved on a comment. */
  onRestore?: (c: LocalComment) => void;
  /** True when the chat sidebar already has an active thread — used to
   *  pick the default promote-button label ("Send to active chat" vs
   *  "Send to new chat"). */
  hasActiveThread: boolean;
  /** Optional fresh iframe screenshot for the file-level composer
   *  (the bubble path captures its own; this fills in for free-form). */
  captureRouteScreenshot?: () => Promise<string | undefined>;
  /** Comment ids that the parent has just-resolved on stream success;
   *  shown in the auto-resolve strip. The parent owns the timer. */
  autoResolvePromptIds?: string[];
  onAutoResolveConfirm?: (ids: string[]) => void;
  onAutoResolveDismiss?: () => void;
};

export function CommentsPanel({
  projectId,
  file,
  onSelectPin,
  selectedPinId,
  onPromoteComments,
  onRestore,
  hasActiveThread,
  captureRouteScreenshot,
  autoResolvePromptIds,
  onAutoResolveConfirm,
  onAutoResolveDismiss,
}: Props) {
  const all = useComments(projectId);

  const [filter, setFilter] = useState<CommentFilter>("open");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop selections that no longer exist (the parent removed/reset the
  // comments). Without this the selection bar can show stale counts.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(all.map((c) => c.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [all]);

  // Per-tab counts drive the filter chip badges.
  const counts = useMemo(() => {
    const sameFile = all.filter((c) => c.file === file);
    const c = {
      open: sameFile.filter((x) => !x.resolved && !x.promoted).length,
      promoted: sameFile.filter((x) => !!x.promoted && !x.resolved).length,
      resolved: sameFile.filter((x) => !!x.resolved).length,
      "all-files": all.length,
    };
    return c;
  }, [all, file]);

  // The visible rows depend on the filter chip + the file scope.
  const visible = useMemo<LocalComment[]>(() => {
    const base = filter === "all-files" ? all : all.filter((c) => c.file === file);
    if (filter === "open") return base.filter((c) => !c.resolved && !c.promoted);
    if (filter === "promoted") return base.filter((c) => !!c.promoted && !c.resolved);
    if (filter === "resolved") return base.filter((c) => !!c.resolved);
    return base;
  }, [all, file, filter]);

  const selectedComments = useMemo(
    () => visible.filter((c) => selected.has(c.id)),
    [visible, selected]
  );

  const otherCount = filter !== "all-files" && all.length - all.filter((c) => c.file === file).length;

  return (
    <div className={s.body}>
      <div className={s.cpFilterRow} role="tablist" aria-label="Comment filter">
        <FilterChip label="Open"     value="open"      filter={filter} setFilter={setFilter} count={counts.open} />
        <FilterChip label="Promoted" value="promoted"  filter={filter} setFilter={setFilter} count={counts.promoted} />
        <FilterChip label="Resolved" value="resolved"  filter={filter} setFilter={setFilter} count={counts.resolved} />
        <FilterChip label="All Files" value="all-files" filter={filter} setFilter={setFilter} count={counts["all-files"]} />
      </div>

      {selectedComments.length > 0 && (
        <SelectionBar
          count={selectedComments.length}
          hasActiveThread={hasActiveThread}
          onPromote={(modelId, mode) => onPromoteComments(selectedComments, modelId, mode)}
          onResolve={() => {
            bulkResolve(projectId, selectedComments.map((c) => c.id), true);
            setSelected(new Set());
          }}
          onDelete={() => {
            for (const c of selectedComments) removeComment(projectId, c.id);
            setSelected(new Set());
          }}
          onClear={() => setSelected(new Set())}
        />
      )}

      {autoResolvePromptIds && autoResolvePromptIds.length > 0 && (
        <div className={s.cpAutoResolveStrip} role="status">
          <span className={s.cpAutoResolveStripText}>
            Resolve {autoResolvePromptIds.length} promoted comment{autoResolvePromptIds.length === 1 ? "" : "s"}?
          </span>
          <button
            className={s.cpAutoResolveStripBtn}
            onClick={() => onAutoResolveConfirm?.(autoResolvePromptIds)}
          >
            Resolve
          </button>
          <button
            className={s.cpAutoResolveStripDismiss}
            onClick={() => onAutoResolveDismiss?.()}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {visible.length === 0 && (
        <EmptyState
          icon={<CommentEmptyIcon />}
          title={emptyTitleFor(filter)}
          body={emptyBodyFor(filter)}
          action={
            filter !== "all-files" && otherCount && otherCount > 0 ? (
              <button
                onClick={() => setFilter("all-files")}
                className={s.commentLinkBtn}
              >
                Show {otherCount} on other file{otherCount === 1 ? "" : "s"}
              </button>
            ) : undefined
          }
          size="md"
        />
      )}

      {visible.map((c, i) => (
        <CommentItem
          key={c.id}
          n={i + 1}
          comment={c}
          checked={selected.has(c.id)}
          onCheckChange={(on) => {
            setSelected((prev) => {
              const next = new Set(prev);
              if (on) next.add(c.id); else next.delete(c.id);
              return next;
            });
          }}
          isPinSelected={c.id === selectedPinId}
          onSelect={() => onSelectPin(c.id === selectedPinId ? null : c.id)}
          onResolve={() => updateComment(projectId, c.id, { resolved: !c.resolved })}
          onDelete={() => { if (selectedPinId === c.id) onSelectPin(null); removeComment(projectId, c.id); }}
          onReask={(modelId) => onPromoteComments([c], modelId, hasActiveThread ? "active" : "new")}
          onRestore={onRestore ? () => onRestore(c) : undefined}
          showFilePath={filter === "all-files"}
        />
      ))}

      <CommentComposer
        projectId={projectId}
        file={file}
        captureRouteScreenshot={captureRouteScreenshot}
      />
    </div>
  );
}

function emptyTitleFor(filter: CommentFilter): string {
  switch (filter) {
    case "open":      return "No open notes on this file";
    case "promoted":  return "Nothing promoted to chat yet";
    case "resolved":  return "No resolved notes";
    case "all-files": return "No notes anywhere yet";
  }
}

function emptyBodyFor(filter: CommentFilter): string {
  switch (filter) {
    case "open":      return "Switch on Comment mode, click anywhere on the canvas, and write a note. It'll show up here.";
    case "promoted":  return "Promote selected notes to chat to ask Claude to act on them.";
    case "resolved":  return "Resolved notes will appear here once you mark them done.";
    case "all-files": return "Click an element with Comment mode on to add your first note.";
  }
}

function CommentEmptyIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

/* ─── Filter chip ──────────────────────────────────────────── */

function FilterChip({
  label, value, filter, setFilter, count,
}: {
  label: string;
  value: CommentFilter;
  filter: CommentFilter;
  setFilter: (v: CommentFilter) => void;
  count: number;
}) {
  const active = filter === value;
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`${s.cpFilterChip} ${active ? s.cpFilterChipActive : ""}`}
      onClick={() => setFilter(value)}
    >
      {label}
      {count > 0 && <span className={s.cpFilterChipCount}>{count}</span>}
    </button>
  );
}

/* ─── Selection bar (sticky, visible when ≥1 row checked) ──── */

function SelectionBar({
  count,
  hasActiveThread,
  onPromote,
  onResolve,
  onDelete,
  onClear,
}: {
  count: number;
  hasActiveThread: boolean;
  onPromote: (modelId: string, mode: PromoteMode) => void;
  onResolve: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const showModelPicker = useModelPickerFlag();
  const [modelId, setModelId] = useState<string>(loadModelId);
  useEffect(() => { saveModelId(modelId); }, [modelId]);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClickAway);
    return () => window.removeEventListener("mousedown", onClickAway);
  }, [open]);

  const primaryMode: PromoteMode = hasActiveThread ? "active" : "new";
  const primaryLabel = hasActiveThread
    ? `↗ Send to chat`
    : `↗ Send to new chat`;

  return (
    <div className={s.cpSelectionBar}>
      <div className={s.cpSelectionHead}>
        <span className={s.cpSelectionCount}>▣ {count} selected</span>
        <button
          className={`${s.cpSelectionBtn} ${s.cpSelectionBtnGhost}`}
          onClick={onClear}
          title="Clear selection"
        >
          × Clear
        </button>
      </div>
      <div className={s.cpSelectionRow}>
        {showModelPicker && (
          <div style={{ minWidth: 0, maxWidth: 140 }}>
            <ModelPicker value={modelId} onChange={setModelId} />
          </div>
        )}
        <span ref={wrapRef} className={s.cpSelectionMenuWrap}>
          <button
            className={`${s.cpSelectionBtn} ${s.cpSelectionBtnPrimary}`}
            onClick={() => onPromote(modelId, primaryMode)}
            title={primaryLabel}
          >
            {primaryLabel}
          </button>
          <button
            className={s.cpSelectionSplitChev}
            onClick={() => setOpen((v) => !v)}
            aria-label="Promote options"
            aria-haspopup="menu"
            aria-expanded={open}
          >
            ▾
          </button>
          {open && (
            <div className={s.cpSelectionMenu} role="menu">
              {hasActiveThread && (
                <button
                  role="menuitem"
                  className={s.cpSelectionMenuItem}
                  onClick={() => { setOpen(false); onPromote(modelId, "active"); }}
                >
                  <span>Send to active chat</span>
                  <span className={s.cpSelectionMenuItemDesc}>
                    Append the bundle as a turn in the current thread.
                  </span>
                </button>
              )}
              <button
                role="menuitem"
                className={s.cpSelectionMenuItem}
                onClick={() => { setOpen(false); onPromote(modelId, "new"); }}
              >
                <span>Send to new thread</span>
                <span className={s.cpSelectionMenuItemDesc}>
                  Spawn a thread named after the first comment.
                </span>
              </button>
              <button
                role="menuitem"
                className={s.cpSelectionMenuItem}
                onClick={() => { setOpen(false); onPromote(modelId, "queue"); }}
              >
                <span>Queue for next turn</span>
                <span className={s.cpSelectionMenuItemDesc}>
                  Wait until the in-flight turn finishes, then send.
                </span>
              </button>
            </div>
          )}
        </span>
        <button className={s.cpSelectionBtn} onClick={onResolve} title="Mark selected resolved">
          ✓ Resolve
        </button>
        <button className={s.cpSelectionBtn} onClick={onDelete} title="Delete selected">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 4 H13 M5 4 V13 a1 1 0 0 0 1 1 H10 a1 1 0 0 0 1 -1 V4 M6 4 V2 H10 V4 M7 7 V11 M9 7 V11" />
          </svg>
          Delete
        </button>
      </div>
    </div>
  );
}

/* ─── Per-row item with checkbox + "..." menu ──────────────── */

function CommentItem({
  n,
  comment,
  checked,
  onCheckChange,
  isPinSelected,
  onSelect,
  onResolve,
  onDelete,
  onReask,
  onRestore,
  showFilePath,
}: {
  n: number;
  comment: LocalComment;
  checked: boolean;
  onCheckChange: (on: boolean) => void;
  isPinSelected: boolean;
  onSelect: () => void;
  onResolve: () => void;
  onDelete: () => void;
  onReask: (modelId: string) => void;
  onRestore?: () => void;
  showFilePath: boolean;
}) {
  const showModelPicker = useModelPickerFlag();
  const [modelId, setModelId] = useState<string>(loadModelId);
  useEffect(() => { saveModelId(modelId); }, [modelId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onAway = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onAway);
    return () => window.removeEventListener("mousedown", onAway);
  }, [menuOpen]);

  const stateBadge = comment.resolved
    ? <span className={`${s.cpStateBadge} ${s.cpStateBadgeResolved}`}>Resolved</span>
    : comment.promoted
      ? <span className={`${s.cpStateBadge} ${s.cpStateBadgePromoted}`}>Promoted</span>
      : null;

  return (
    <div
      className={`${s.commentItem} ${isPinSelected ? s.commentItemSelected : ""} ${comment.resolved ? s.commentItemResolved : ""}`}
      onClick={onSelect}
    >
      <div className={s.commentRow}>
        {/* Drag handle is visual-only; reserved for a sibling agent's
            drag-to-reorder PR. */}
        <span className={s.cpRowDragHandle} aria-hidden />

        <input
          type="checkbox"
          className={s.cpRowCheckbox}
          checked={checked}
          onChange={(e) => onCheckChange(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          aria-label="Select for promotion"
        />

        <span className={s.commentPin}>{n}</span>
        {comment.thumbnail && (
          <img className={s.commentThumb} src={comment.thumbnail} alt="" loading="lazy" />
        )}
        <div className={s.commentRef}>
          {(comment.tag || comment.descriptor) && (() => {
            const lbl = smartLabel({
              descriptor: comment.descriptor,
              kind: comment.kind,
              tag: comment.tag,
            });
            return (
              <span className={s.refTag} title={comment.descriptor?.label ?? lbl.full}>
                {lbl.full}
              </span>
            );
          })()}
          {comment.innerText && (
            <span className={s.commentSnippet}>"{comment.innerText.slice(0, 48)}"</span>
          )}
          {showFilePath && (
            <span className={s.commentSnippet} style={{ fontStyle: "normal", opacity: 0.7 }}>
              {comment.file}
            </span>
          )}
          {stateBadge}
        </div>

        <div className={s.cpRowMenu} ref={menuRef}>
          <button
            className={s.cpRowMenuBtn}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className={s.cpRowMenuPopup} role="menu">
              <button
                role="menuitem"
                className={s.cpRowMenuItem}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onReask(modelId); }}
              >
                ↗ Re-ask AI
              </button>
              <button
                role="menuitem"
                className={s.cpRowMenuItem}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onSelect(); }}
              >
                ⎘ Jump to pin
              </button>
              <button
                role="menuitem"
                className={s.cpRowMenuItem}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onResolve(); }}
              >
                {comment.resolved ? "Reopen" : "✓ Resolve"}
              </button>
              {onRestore && comment.domHtml && (
                <button
                  role="menuitem"
                  className={s.cpRowMenuItem}
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRestore(); }}
                >
                  ↺ Restore snapshot
                </button>
              )}
              <button
                role="menuitem"
                className={s.cpRowMenuItem}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
              >
                🗑 Delete
              </button>
            </div>
          )}
        </div>
      </div>
      <div className={s.commentBody}>{comment.body}</div>

      {showModelPicker && (
        <div className={s.commentActions}>
          <div
            className={s.commentModelPicker}
            onClick={(e) => e.stopPropagation()}
          >
            <ModelPicker value={modelId} onChange={setModelId} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── File-level free-form composer ────────────────────────── */
//
// Captures the page route, scroll position, and a fresh route screenshot
// so the comment isn't an unmoored note. Anchored comments still come
// in via the iframe CommentBubble path; this composer fills the gap for
// "I've got a thought about this view as a whole" notes.

function CommentComposer({
  projectId,
  file,
  captureRouteScreenshot,
}: {
  projectId: string;
  file: string;
  captureRouteScreenshot?: () => Promise<string | undefined>;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    // Snapshot the iframe once at submit time. The shot is best-effort —
    // if it fails (cross-origin, zero-size, etc.), we still save the
    // body so the user doesn't lose their note.
    let thumbnail: string | undefined;
    try {
      thumbnail = await captureRouteScreenshot?.();
    } catch { /* best-effort */ }
    const scrollY =
      typeof window !== "undefined" ? window.scrollY : undefined;
    addComment(projectId, {
      file,
      selector: "",
      body: t,
      thumbnail,
      scrollY,
    });
    setText("");
  };

  return (
    <form
      className={s.commentComposer}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      <textarea
        ref={ref}
        className={s.composerField}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
        }}
        placeholder="Add a note about this file… (Enter to save)"
      />
      <button
        type="submit"
        className={s.composerSend}
        disabled={!text.trim()}
        title="Save comment (with route + screenshot)"
      >
        +
      </button>
    </form>
  );
}
