/* Onboard.tsx — full-page intake chat for a freshly-created project.
 *
 * The user lands here after creating a new project. They talk to Claude
 * about what they want to build before any file editing begins. The
 * thread is persisted to the same localStorage key the Editor uses, so
 * when they hit "Open editor →" the conversation just continues there.
 *
 * What this file owns:
 *   - Local state for the active thread (loaded from / saved to
 *     localStorage on the same per-project key as Editor.tsx).
 *   - The `runTurn` machinery: POST /api/comment-edit, parse SSE,
 *     mutate the assistant message in place.
 *   - The intake auto-greet effect.
 *
 * What it borrows from ChatSidebar:
 *   - <ChatBody> renders the bubbles
 *   - <Composer> handles input + paste/drop + the Stop button
 *   - <ElicitForm> renders any structured question Claude asks
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import s from "../components/editor/chat.module.css";
import os from "../components/projects/projects.module.css";
import { useProjects, hydrateProjectFromServer } from "../lib/projects";
import { loadModelId } from "../components/editor/ModelPicker";
import {
  Composer,
  QueuedBubble,
  type ChatMessage,
  type ChatThread,
  type ThreadArchive,
  type QueuedMessage,
} from "../components/editor/ChatSidebar";
import type { Attachment } from "../components/editor/CommentBubble";
import { ElicitForm } from "../components/editor/ElicitForm";
import {
  startStream,
  subscribeStream,
  isStreamActive,
  getStreamState,
  abortStream,
  newStreamId,
  type StreamEvent,
  type ElicitRequest,
} from "../lib/chatStream";
import { trackEvent } from "../lib/telemetry";
import { loadThreads as libLoadThreads, saveThreads, subscribeThreads } from "../lib/threads";

/* ─── Persistence ─────────────────────────────────────────────────── *
 * Threads live server-side at `web/projects/<id>/.meta/threads.json`
 * via `lib/threads.ts` — backed by an in-memory cache so this loader
 * is synchronous. The local sanitizer fixes pending messages whose
 * stream is dead (e.g. the page reloaded mid-stream). */

function loadOnboardThreads(projectId: string): ThreadArchive {
  const archive = libLoadThreads(projectId);
  let dirty = false;
  const threads = archive.threads.map((t) => {
    if (!t.messages) return t;
    let touched = false;
    const messages = t.messages.map((m, i, arr) => {
      if (m.role !== "assistant" || !m.pending) return m;
      const userMsg = arr[i - 1];
      const streamId = userMsg && userMsg.role === "user" ? userMsg.streamId : undefined;
      if (isStreamActive(streamId)) return m;
      touched = true;
      return {
        ...m,
        pending: false,
        error: m.error ?? (m.content ? "Run interrupted — page reloaded mid-stream." : "Run interrupted before any reply arrived."),
      };
    });
    if (!touched) return t;
    dirty = true;
    return { ...t, messages };
  });
  // Drop an orphan activeId — disk can hold an activeId pointing to a
  // thread that was never persisted (the data-loss race we just fixed
  // produced exactly this state). Without this, useState seeds a non-
  // existent active thread → ChatBody renders empty → user is stuck.
  const validActiveId = threads.some((t) => t.id === archive.activeId)
    ? archive.activeId
    : null;
  if (validActiveId !== archive.activeId) dirty = true;
  return dirty ? { threads, activeId: validActiveId } : archive;
}

function mintSessionId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* ─── Component ─────────────────────────────────────────────────── */

export default function Onboard() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { all: allProjects } = useProjects();
  const project = useMemo(() => allProjects.find((p) => p.id === projectId), [allProjects, projectId]);

  const [threads, setThreads] = useState<ChatThread[]>(() => loadOnboardThreads(projectId).threads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    () => loadOnboardThreads(projectId).activeId,
  );
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? threads[0] ?? null;

  const [pendingElicit, setPendingElicit] = useState<{ request: ElicitRequest; threadId: string } | null>(null);
  // One-slot composer queue. Same rationale as Editor.tsx — typing into
  // a disabled composer used to silently drop, and a micro-window
  // between assistant chunks could spawn a concurrent SDK turn on the
  // same sessionId. Hold the message here until the turn drains.
  const [queued, setQueued] = useState<(QueuedMessage & { threadId: string }) | null>(null);

  // Persist on every change so opening the editor mid-conversation
  // hydrates the same thread. Threads now live server-side; the lib
  // debounces 300ms before PATCH and broadcasts via SSE so other tabs
  // see the change.
  useEffect(() => {
    if (!projectId) return;
    saveThreads(projectId, { threads, activeId: activeThreadId });
  }, [threads, activeThreadId, projectId]);

  // Cross-tab sync: refresh state when another tab/browser updates
  // the same project's threads. Re-run the pending sanitizer here too
  // — the synchronous useState initializer ran on an empty cache, so
  // any pending:true from disk would otherwise survive the async load.
  // The sanitizer also drops orphan activeIds for free.
  useEffect(() => {
    if (!projectId) return;
    return subscribeThreads(projectId, () => {
      const sanitized = loadOnboardThreads(projectId);
      setThreads(sanitized.threads);
      setActiveThreadId(sanitized.activeId);
    });
  }, [projectId]);

  // Hydration: if the project is on disk but not in our local store
  // (direct URL, fresh browser, cleared storage), pull it from the
  // server's manifest and add it to localStorage. While that's in
  // flight we render a small "Loading project…" placeholder instead
  // of bouncing — bouncing would lose the URL.
  const [hydrating, setHydrating] = useState(false);
  const [hydrateFailed, setHydrateFailed] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    if (project) return;          // already loaded
    if (hydrating) return;        // already trying
    if (hydrateFailed) return;    // give up after one attempt
    setHydrating(true);
    hydrateProjectFromServer(projectId).then((p) => {
      setHydrating(false);
      if (!p) setHydrateFailed(true);
      // Successful hydration triggers `projects:change` → useProjects
      // re-reads → `project` becomes truthy on the next render.
    });
  }, [projectId, project, hydrating, hydrateFailed]);

  // NB: All hooks declared above this point. Early-return branches that
  // depend on `project` live AFTER the last hook (search "early-returns")
  // so React's hook count stays stable across renders.

  /* ─── Thread mutation primitives ─────────────────────────────── */

  const startNewThread = (title?: string): ChatThread => {
    const t: ChatThread = {
      id: mintSessionId(),
      title: title ?? "Project intake",
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

  const deleteMessagesFrom = (threadId: string, index: number) => {
    setThreads((prev) => prev.map((t) => {
      if (t.id !== threadId) return t;
      for (let i = index; i < t.messages.length; i++) {
        const m = t.messages[i];
        if (m.role === "user" && m.streamId) abortStream(m.streamId);
      }
      return { ...t, messages: t.messages.slice(0, index) };
    }));
    setPendingElicit((p) => (p && p.threadId === threadId ? null : p));
  };

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

  const buildStreamHandler = (threadId: string, aIdx: number) => {
    const updateAssistant = makeAssistantUpdater(threadId, aIdx);
    let textBuf = "";
    let thinkBuf = "";
    let scheduled = false;
    const FLUSH_MS = 33;
    const flush = () => {
      scheduled = false;
      if (!textBuf && !thinkBuf) return;
      const t = textBuf; textBuf = "";
      const k = thinkBuf; thinkBuf = "";
      updateAssistant((m) => ({
        ...m,
        content: t ? m.content + t : m.content,
        thinking: k ? (m.thinking ?? "") + k : m.thinking,
      }));
    };
    const schedule = () => { if (!scheduled) { scheduled = true; setTimeout(flush, FLUSH_MS); } };

    return (e: StreamEvent) => {
      if (e.type === "text") { textBuf += e.chunk; schedule(); return; }
      if (e.type === "thinking") { thinkBuf += e.chunk; schedule(); return; }
      if (e.type === "tool") { updateAssistant((m) => ({ ...m, tools: [...m.tools, e.tool] })); return; }
      if (e.type === "turnId") { updateAssistant((m) => ({ ...m, turnId: e.turnId })); return; }
      if (e.type === "elicit") {
        setPendingElicit({ request: e.request, threadId });
        setActiveThreadId(threadId);
        return;
      }
      if (e.type === "elicitClear") {
        setPendingElicit((p) => (p && p.request.id === e.id ? null : p));
        return;
      }
      if (e.type === "error") {
        flush();
        setPendingElicit(null);
        updateAssistant((m) => ({ ...m, error: e.message, pending: false }));
        return;
      }
      if (e.type === "done") {
        flush();
        setPendingElicit(null);
        updateAssistant((m) => {
          if (!m.content && !m.error && m.tools.length > 0) {
            return { ...m, content: `Made ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}.`, pending: false };
          }
          if (!m.content && !m.error) {
            return { ...m, error: "No reply received from AI.", pending: false };
          }
          return { ...m, pending: false };
        });
      }
    };
  };

  // Re-attach streams across remounts (HMR).
  useEffect(() => {
    if (!activeThread) return;
    const last = activeThread.messages[activeThread.messages.length - 1];
    if (!last || last.role !== "assistant" || !last.pending) return;
    const userMsg = activeThread.messages[activeThread.messages.length - 2];
    const streamId = userMsg && userMsg.role === "user" ? userMsg.streamId : undefined;
    if (!streamId || !isStreamActive(streamId)) return;
    const aIdx = activeThread.messages.length - 1;
    const cur = getStreamState(streamId);
    if (cur) {
      makeAssistantUpdater(activeThread.id, aIdx)((m) => ({
        ...m,
        content: cur.text || m.content,
        thinking: cur.thinking || m.thinking,
        tools: cur.tools.length > 0 ? cur.tools : m.tools,
        turnId: cur.turnId ?? m.turnId,
        error: cur.error ?? m.error,
      }));
      if (cur.elicit) setPendingElicit({ request: cur.elicit, threadId: activeThread.id });
    }
    const handler = buildStreamHandler(activeThread.id, aIdx);
    return subscribeStream(streamId, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id, activeThread?.messages.length]);

  /* ─── runTurn: post + stream ─────────────────────────────────── */

  const runTurn = async (opts: { text: string; attachments?: Attachment[]; modelId?: string; startNewThread?: boolean; hidden?: boolean }) => {
    let thread = activeThread;
    if (opts.startNewThread || !thread) thread = startNewThread();
    const threadId = thread.id;

    const streamId = newStreamId();
    const userMsg: ChatMessage = {
      role: "user",
      content: opts.text,
      route: "index.html", // sandbox starter page
      streamId,
      modelId: opts.modelId,
      hidden: opts.hidden,
      ts: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      tools: [],
      ts: Date.now(),
      pending: true,
    };
    const aIdx = thread.messages.length + 1;

    setThreads((prev) => prev.map((t) =>
      t.id === threadId ? { ...t, messages: [...t.messages, userMsg, assistantMsg] } : t,
    ));
    if (thread.messages.length === 0) {
      setThreads((prev) => prev.map((t) =>
        t.id === threadId ? { ...t, title: generateThreadTitle(opts.text) } : t,
      ));
    }

    trackEvent("onboard_send", { len: String(opts.text.length) }, projectId);

    const handler = buildStreamHandler(threadId, aIdx);
    await startStream({
      streamId,
      body: {
        route: "index.html",
        selector: "",
        comment: opts.text,
        attachments: opts.attachments ?? [],
        sessionId: thread.id,
        modelId: opts.modelId,
        projectId,
      },
      listener: handler,
    });
  };

  /* ─── Auto-greet (intake prompt) ─────────────────────────────── */

  const intakeFiredRef = useRef(false);
  useEffect(() => {
    if (!project) return;
    if (intakeFiredRef.current) return;
    if (threads.length > 0) {
      // Already mid-conversation (returning to onboard) — don't re-fire.
      intakeFiredRef.current = true;
      return;
    }
    intakeFiredRef.current = true;
    // Intake prompt is intentionally domain-agnostic. The artifact-type
    // options span the full surface of what people make in Figma, not
    // just video overlays — so this prompt works whether the project is
    // a landing page, a deck, a logo, a thumbnail, or anything else. The
    // structure (ask first → structured form for discrete choices →
    // prose for open-ended → frontend-design skill before code) follows
    // common design-tool intake patterns.
    const intake = [
      `New project: "${project.name}". Empty sandbox — index.html and style.css are scaffolding.`,
      ``,
      `Don't touch any file yet. First, understand what I want.`,
      ``,
      `Open with one structured question via \`mcp__ask-user__ask_user\` (kind: "enum") to pin down what kind of artifact this is. Use options like:`,
      `  • Product UI (app, dashboard, web app)`,
      `  • Landing page / marketing site`,
      `  • Design system / UI kit`,
      `  • Presentation / deck`,
      `  • Social or marketing graphic (post, banner, ad)`,
      `  • Video overlay (thumbnail, lower third, title card)`,
      `  • Brand asset (logo, identity)`,
      `  • Wireframe / flow`,
      `  • Prototype (clickable, animated)`,
      `  • Other — let me describe it`,
      ``,
      `Use the project name as a hint when ordering or pre-selecting options.`,
      ``,
      `Then ask 5–8 focused follow-ups, mixing \`ask_user\` (for discrete choices) and prose (open-ended). Cover the standard intake checklist:`,
      `  • output details (size, aspect ratio, fidelity)`,
      `  • option count (how many variations, and across which dimensions)`,
      `  • constraints (timing, copy length, platform rules, accessibility)`,
      `  • design system / brand context (existing tokens, references to upload, or starting fresh)`,
      ``,
      `If I'm starting fresh with no existing design system, invoke the \`frontend-design\` skill before any code so you commit to a bold aesthetic direction up front.`,
      ``,
      `When you've gathered enough to start, end your final reply with the marker [READY_TO_BUILD] on its own line. The UI watches for that marker and auto-opens the editor for you — don't ask me to click anything. One question at a time, conversational. Don't read the starter files yet.`,
    ].join("\n");
    runTurn({ text: intake, modelId: loadModelId(), startNewThread: true, hidden: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  /* ─── Stop ───────────────────────────────────────────────────── */

  const onStop = () => {
    const t = activeThread;
    if (!t) return;
    const lastUser = [...t.messages].reverse().find((m) => m.role === "user") as
      | Extract<ChatMessage, { role: "user" }>
      | undefined;
    if (lastUser?.streamId) abortStream(lastUser.streamId);
    setPendingElicit((p) => (p && p.threadId === t.id ? null : p));
  };

  const goToEditor = () => navigate("/editor");

  // Is the last assistant message still streaming?
  const lastMsg = activeThread?.messages.at(-1);
  const lastAssistant = lastMsg?.role === "assistant"
    ? (lastMsg as Extract<ChatMessage, { role: "assistant" }>)
    : null;
  const lastIsPending = !!lastAssistant?.pending;
  const isBlocked = lastIsPending || !!pendingElicit;

  // ─── Composer queue (one-slot) ────────────────────────────────
  // Wrap the composer's onSend: if the active turn is still streaming
  // (or an elicit form is open) hold the message in `queued` instead
  // of starting a concurrent SDK turn. The drain effect below fires
  // it once the turn ends.
  //
  // Special case: when the composer submits while an elicit form is on
  // screen, treat the typed text as the elicit answer (POST to
  // /api/elicit-response). Otherwise the message would queue waiting
  // for an event that never comes (the SDK is blocked on the elicit),
  // and the user sees their reply silently disappear.
  const queueOrSend = (text: string, attachments: Attachment[], modelId: string) => {
    if (pendingElicit) {
      const answeredId = pendingElicit.request.id;
      // Clear local form first so the UI updates immediately even if the
      // POST takes a moment.
      setPendingElicit(null);
      void fetch("/api/elicit-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: answeredId, action: "accept", content: { answer: text } }),
      }).catch(() => { /* offline — server-side timeout will recover */ });
      return;
    }
    if (isBlocked && activeThread) {
      setQueued({
        text,
        attachments,
        modelId,
        queuedAt: Date.now(),
        threadId: activeThread.id,
      });
      return;
    }
    runTurn({ text, attachments, modelId });
  };

  useEffect(() => {
    if (!queued) return;
    if (isBlocked) return;
    if (!activeThread || activeThread.id !== queued.threadId) return;
    const q = queued;
    // Intentional: drain on `isBlocked` flipping false. Clear the slot
    // before fire-off so a re-render race can't double-fire.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueued(null);
    runTurn({ text: q.text, attachments: q.attachments, modelId: q.modelId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBlocked, queued, activeThread?.id]);

  // Drop the queued message if the user switches threads (or the
  // queued thread vanishes) — firing into a different sessionId would
  // be surprising.
  useEffect(() => {
    if (!queued) return;
    if (!activeThread || activeThread.id !== queued.threadId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQueued(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id]);

  // Watch for Claude's "ready" marker and auto-navigate.
  const READY_RE = /\[READY_TO_BUILD\]/i;
  const isReady = !!lastAssistant && !lastAssistant.pending && READY_RE.test(lastAssistant.content);
  useEffect(() => {
    if (!isReady) return;
    const t = setTimeout(() => navigate("/editor"), 1400);
    return () => clearTimeout(t);
  }, [isReady, navigate]);

  /* ─── early-returns (project lifecycle) ──────────────────────────
   * MUST come after every hook so React's hook count is stable across
   * renders. The hydration useEffect above resolves these synchronously
   * once the manifest fetch lands. */
  if (!projectId) return <BounceToProjects />;
  if (hydrateFailed) return <BounceToProjects />;
  if (!project) {
    return (
      <div className={s.onboardShell}>
        <main className={s.onboardMain}>
          <div className={s.onboardWizard}>
            <WizardLoading title="Loading project…" subtitle="Pulling project metadata from the server." />
          </div>
        </main>
      </div>
    );
  }

  // The current "open question" — Claude's latest prose reply, with the
  // ready marker stripped if present. Shown when there's no elicit form.
  const currentQuestion = lastAssistant && !lastAssistant.pending
    ? lastAssistant.content.replace(READY_RE, "").trim()
    : "";

  // Mode the wizard is in.
  const mode: "starting" | "thinking" | "form" | "question" | "ready" =
    isReady                                  ? "ready"
    : pendingElicit                          ? "form"
    : lastIsPending                          ? "thinking"
    : currentQuestion                        ? "question"
    : "starting";

  /* ─── Render ─────────────────────────────────────────────────── */

  return (
    <div className={s.onboardShell}>
      <header className={s.onboardHeader}>
        <button className={s.onboardBack} onClick={() => navigate("/projects")} title="Back to projects">
          ← Projects
        </button>
        <div className={s.onboardTitle}>{project?.name ?? "New project"}</div>
        <button
          className={`${os.dialogBtn} ${os.dialogPrimary}`}
          onClick={goToEditor}
          title="Skip the conversation and open the editor now"
        >
          Skip to editor →
        </button>
      </header>

      <main className={s.onboardMain}>
        <div className={s.onboardWizard}>
          {mode === "starting" && (
            <WizardLoading title="Starting…" subtitle="Setting up the conversation. The first question will appear in a moment." />
          )}

          {mode === "thinking" && (
            <WizardLoading title="Thinking…" subtitle="Preparing the next question." />
          )}

          {mode === "question" && (
            <div className={s.wizardQuestion}>
              <div className={s.wizardDot} />
              <div className={s.wizardQuestionText}>{currentQuestion}</div>
            </div>
          )}

          {mode === "form" && pendingElicit && (
            <ElicitForm
              key={pendingElicit.request.id}
              request={pendingElicit.request}
              onResolved={(_echo) => setPendingElicit(null)}
            />
          )}

          {mode === "ready" && (
            <div className={s.wizardReady}>
              <div className={s.wizardReadyMark}>✓</div>
              <div className={s.wizardReadyTitle}>Ready to build</div>
              <div className={s.wizardReadySub}>{currentQuestion || "Opening the editor…"}</div>
              <button
                className={`${os.dialogBtn} ${os.dialogPrimary}`}
                onClick={goToEditor}
              >
                Open editor →
              </button>
            </div>
          )}

          {/* Composer stays mounted across every mode (except `ready`)
              so text the user is typing isn't dropped when Claude opens
              a new structured form mid-keystroke. Also wired with a
              draftKey so a remount (project switch, hard-refresh) keeps
              the in-progress answer. When a form is up the composer
              shows a small "or type your own answer" hint above it. */}
          {mode !== "ready" && (
            <div className={s.wizardComposer}>
              {mode === "form" && (
                <div className={s.wizardComposerHint}>
                  Or type your own answer below
                </div>
              )}
              {queued && activeThread && queued.threadId === activeThread.id && (
                <QueuedBubble
                  message={{
                    text: queued.text,
                    attachments: queued.attachments,
                    modelId: queued.modelId,
                    queuedAt: queued.queuedAt,
                  }}
                  onCancel={() => setQueued(null)}
                />
              )}
              <Composer
                disabled={lastIsPending}
                hasQueued={!!queued && !!activeThread && queued.threadId === activeThread.id}
                onSend={(text, attachments, modelId) => queueOrSend(text, attachments, modelId)}
                onStop={lastIsPending ? onStop : undefined}
                draftKey={activeThread ? `onboard-draft:${activeThread.id}` : undefined}
                projectId={projectId}
              />
            </div>
          )}
        </div>
      </main>

      {/* renameThread + deleteMessagesFrom intentionally unused on the
          onboarding wizard. Kept in scope so future variations can use them. */}
      <span style={{ display: "none" }}>{renameThread.length}{deleteMessagesFrom.length}</span>
    </div>
  );
}

function WizardLoading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className={s.wizardLoading}>
      <div className={s.streamingDots}>
        <span /><span /><span />
      </div>
      <div className={s.wizardLoadingTitle}>{title}</div>
      <div className={s.wizardLoadingSub}>{subtitle}</div>
    </div>
  );
}

function BounceToProjects() {
  const navigate = useNavigate();
  useEffect(() => { navigate("/projects", { replace: true }); }, [navigate]);
  return null;
}

function generateThreadTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + "…";
}
