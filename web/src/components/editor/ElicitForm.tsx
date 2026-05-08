/* ElicitForm.tsx — renders an MCP elicitation form inside the chat sidebar.
 *
 * The dev server emits an `elicit` SSE event when Claude calls ask_user
 * (mcp/ask-user-server.mjs). We surface a structured form with N
 * questions for the user to fill, then POST the answers to
 * /api/elicit-response so the server resolves the pending elicitation
 * and Claude can continue.
 *
 * Schema shape we expect (built by mcp/ask-user-server.mjs):
 *   {
 *     type: "object",
 *     title: "Quick questions about ...",
 *     properties: {
 *       <snake_case_id>: <field-schema>,   // one entry per question
 *       ...
 *     },
 *     required: [<id>, ...]
 *   }
 *
 * Per-question field kinds we support:
 *   - enum single  → radio        { type:"string", enum:[…] }
 *   - enum multi   → checkbox     { type:"array",  items:{ type:"string", enum:[…] } }
 *   - number       → range/slider { type:"number", minimum, maximum, multipleOf }
 *   - boolean      → toggle       { type:"boolean" }
 *   - dropzone     → file drop    { type:"string", format:"uri", "x-input":"dropzone" }
 *   - textarea     → textarea     { type:"string", "x-input":"textarea" }
 *   - string       → text input   { type:"string" }
 *
 * Two escape-hatch patterns coexist:
 *   1. ENUM kinds: when the field schema has `x-other-input: true`, we
 *      render an inline `Other…` textarea below the chip row. Selecting
 *      an "Other" chip focuses the textarea; typed content REPLACES
 *      "Other" in the answer (so the model sees the literal user text).
 *      The MCP server auto-injects "Decide for me" / "Explore a few" /
 *      "Other" options server-side for every enum question.
 *   2. NON-ENUM kinds (number, boolean, dropzone): a per-question
 *      "Other" toggle bypasses the structured input and falls back to
 *      a freeform textarea — useful when the model's choices don't
 *      cover what the user wants.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import s from "./chat.module.css";
import type { ElicitRequest } from "../../lib/chatStream";
import { parsePartialQuestions, type StreamingQuestion } from "../../lib/streamingJson";

type Schema = Record<string, unknown> | undefined;

type Question = {
  id: string;
  schema: Schema;
  required: boolean;
  title: string;
  subtitle?: string;
};

type Props = {
  /** Real elicitation request — present once the MCP elicitation has
   *  fired and the form is ready to accept answers. */
  request?: ElicitRequest | null;
  /** Streaming preview, before the elicitation fires. The form
   *  derives questions by lenient-parsing `partialJson` and renders
   *  them progressively without any submit affordance. */
  preview?: { toolUseId: string; partialJson: string; done: boolean } | null;
  /** Called once the user submits / declines / cancels.
   *  When `accept`, `answers` carries the final per-question values
   *  so the parent can echo them into the chat as a synthetic user
   *  message (see Editor.tsx). Required when `request` is set. */
  onResolved?: (action: "accept" | "decline" | "cancel", answers?: Record<string, unknown>) => void;
  /** "inline" = sidebar render (default; heavier chrome to draw
   *  attention inside the chat scroll); "tab" = canvas-tab render
   *  (lighter chrome, larger typography, more whitespace — the
   *  surrounding tab area is already a focused surface). */
  variant?: "inline" | "tab";
};

export function ElicitForm({ request, preview, onResolved, variant = "inline" }: Props) {
  const isPreview = !request && !!preview;

  // Source of truth for the question list. Real mode parses the
  // server-built schema; preview mode lenient-parses the streaming
  // JSON. The latter is recomputed on every delta — cheap enough at
  // O(n) over partialJson, and the question id-set only ever grows
  // monotonically so React diffs are well-behaved.
  const questions = useMemo<Question[]>(() => {
    if (request?.schema) return parseQuestions(request.schema);
    if (preview) {
      const parsed = parsePartialQuestions(preview.partialJson);
      return parsed.questions.map(streamingQuestionToQuestion);
    }
    return [];
  }, [request?.schema, preview?.partialJson]);

  // Header text. Preview mode shows the streamed `title` as soon as
  // its closing quote has arrived; real mode uses request.message.
  const headerTitle = useMemo(() => {
    if (request?.message) return request.message;
    if (preview) {
      const parsed = parsePartialQuestions(preview.partialJson);
      return parsed.title ?? "Generating questions…";
    }
    return "";
  }, [request?.message, preview?.partialJson]);

  // Persist in-progress answers to localStorage so a page reload
  // doesn't drop everything the user already typed. The key is keyed
  // off the elicit's id (real form) or the toolUseId (preview state),
  // whichever is the stable handle right now. When promotion happens
  // (preview gets its real id), we copy the draft over so nothing is
  // lost across the transition. Cleared on resolve.
  const draftKey = request?.id ? `elicit-draft:${request.id}` : preview ? `elicit-draft:preview:${preview.toolUseId}` : null;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => {
    const fromQuestions = Object.fromEntries(questions.map((q) => [q.id, initialValue(q.schema)]));
    if (!draftKey) return fromQuestions;
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(draftKey) : null;
      if (!raw) return fromQuestions;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Merge: fromQuestions provides defaults; parsed wins per-key.
      return { ...fromQuestions, ...parsed };
    } catch {
      return fromQuestions;
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Migrate the draft when the elicit promotes from preview→real.
  // Both keys live in localStorage simultaneously for a beat; we
  // copy from the preview key over the real key, then clear the
  // preview key so it doesn't accumulate.
  useEffect(() => {
    if (!request?.id || !preview?.toolUseId) return;
    if (typeof localStorage === "undefined") return;
    const previewKey = `elicit-draft:preview:${preview.toolUseId}`;
    const realKey = `elicit-draft:${request.id}`;
    const previewDraft = localStorage.getItem(previewKey);
    if (previewDraft && !localStorage.getItem(realKey)) {
      localStorage.setItem(realKey, previewDraft);
      localStorage.removeItem(previewKey);
    }
  }, [request?.id, preview?.toolUseId]);

  // Write answers to localStorage on every change. Cheap (small JSON,
  // synchronous) and keeps reload-survival reliable. The cleanup on
  // resolve happens in `send()` below.
  useEffect(() => {
    if (!draftKey || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(draftKey, JSON.stringify(answers));
    } catch {
      // Quota exceeded or private mode — non-fatal; the form just
      // won't survive a reload, which is the prior behavior.
    }
  }, [draftKey, answers]);

  // Sync answers map when new questions arrive during streaming. We
  // only ADD missing keys; existing user input is preserved across
  // delta updates and across the preview→real promotion.
  useEffect(() => {
    setAnswers((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const q of questions) {
        if (!(q.id in next)) {
          next[q.id] = initialValue(q.schema);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [questions]);

  // Per-question required-and-not-yet-valid count. Drives the "(N more)"
  // hint next to a disabled Continue button so the user knows what's
  // standing between them and submission.
  const missingRequired = isPreview
    ? questions.filter((q) => q.required).length
    : questions.filter((q) => q.required && !isValid(q.schema, answers[q.id])).length;
  const allValid = !isPreview && missingRequired === 0;

  const send = async (action: "accept" | "decline" | "cancel") => {
    if (submitting || !request) return;
    setSubmitting(true);
    setErrorMsg(null);
    // The MCP elicitation contract: `content` matches the
    // `requestedSchema` shape directly. Our schema has flat per-
    // question properties (platform, discipline, …), so the answers
    // map IS the content — no wrapper. Wrapping it under `{ answers }`
    // (an earlier mistake) made the SDK validate the wrapper against
    // the flat schema and reject every reply with invalid_union.
    const body: { id: string; action: string; content?: Record<string, unknown> } = {
      id: request.id,
      action,
    };
    if (action === "accept") {
      body.content = answers;
    }
    try {
      const res = await fetch("/api/elicit-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErrorMsg(j?.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      // Clear both potential draft keys (real + preview) so the
      // form starts clean next time. Cheap and idempotent.
      if (typeof localStorage !== "undefined") {
        try {
          if (request?.id) localStorage.removeItem(`elicit-draft:${request.id}`);
          if (preview?.toolUseId) localStorage.removeItem(`elicit-draft:preview:${preview.toolUseId}`);
        } catch { /* ignore */ }
      }
      onResolved?.(action, action === "accept" ? answers : undefined);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className={s.elicitCard} data-preview={isPreview ? "true" : undefined} data-variant={variant}>
      <div className={s.elicitHeader}>
        <span className={s.elicitDot} />
        <span className={s.elicitTitle}>{headerTitle}</span>
      </div>

      <div className={s.elicitBody}>
        {questions.map((q) => (
          <QuestionSection
            key={q.id}
            question={q}
            value={answers[q.id]}
            onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
            onSubmitShortcut={() => { if (allValid) send("accept"); }}
          />
        ))}
      </div>

      {errorMsg && <div className={s.elicitError}>{errorMsg}</div>}

      <div className={s.elicitActions}>
        {isPreview ? (
          <span className={s.elicitGenerating}>
            {questions.length > 0
              ? `Generating question ${questions.length + 1}…`
              : "Generating questions…"}
          </span>
        ) : missingRequired > 0 && questions.length > 0 ? (
          <span className={s.elicitMissingHint}>
            {missingRequired} more required
          </span>
        ) : null}
        <div className={s.elicitActionsSpacer} />
        <button
          className={s.elicitBtn}
          onClick={() => send("cancel")}
          disabled={isPreview || submitting}
        >
          Cancel
        </button>
        <button
          className={`${s.elicitBtn} ${s.elicitPrimary}`}
          onClick={() => send("accept")}
          disabled={isPreview || !allValid || submitting}
        >
          {submitting ? "Sending…" : questions.length > 1 ? "Continue" : "Send answer"}
        </button>
      </div>
    </div>
  );
}

/* ─── Streaming → Question schema adapter ───────────────────────── */

/** Map a streaming-parsed question (shape from ask_user input JSON)
 *  into the internal Question structure. Mirrors what the MCP server
 *  does on its side for fully-formed inputs, but tolerant of missing
 *  fields — the JSON is partial and the form needs to render even
 *  when e.g. the options array hasn't streamed in yet. */
function streamingQuestionToQuestion(q: StreamingQuestion): Question {
  const id = typeof q.id === "string" ? q.id : "_unnamed";
  const kind = typeof q.kind === "string" ? q.kind : "text";
  const title = typeof q.title === "string" ? q.title : id;
  const subtitle = typeof q.subtitle === "string" ? q.subtitle : undefined;
  const required = q.required !== false;

  let schema: Record<string, unknown>;
  if (kind === "enum") {
    const opts = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [];
    const RESERVED = new Set(["Decide for me", "Explore a few", "Other"]);
    const userOpts = opts.filter((o) => !RESERVED.has(o));
    const finalOptions = [...userOpts, "Decide for me", "Explore a few", "Other"];
    // Mirror the server-side schema synthesis: x-options for the UI,
    // unconstrained type for the wire so free-form Other text passes
    // elicit validation.
    schema = q.multi
      ? { type: "array", items: { type: "string" }, "x-options": finalOptions, "x-other-input": true }
      : { type: "string", "x-options": finalOptions, "x-other-input": true };
  } else if (kind === "svg-options") {
    const opts = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [];
    const labels = Array.isArray(q.optionLabels)
      ? (q.optionLabels as unknown[]).filter((l): l is string => typeof l === "string")
      : [];
    const indexOptions = opts.map((_, i) => String(i));
    const finalOptions = [...indexOptions, "Decide for me", "Other"];
    schema = {
      type: "string",
      "x-options": finalOptions,
      "x-input": "svg-options",
      "x-svg-options": opts,
      "x-svg-labels": labels,
      "x-other-input": true,
    };
  } else if (kind === "number") {
    schema = {
      type: "number",
      ...(typeof q.min === "number" ? { minimum: q.min } : {}),
      ...(typeof q.max === "number" ? { maximum: q.max } : {}),
      ...(typeof q.step === "number" ? { multipleOf: q.step } : {}),
    };
  } else if (kind === "boolean") {
    schema = { type: "boolean" };
  } else if (kind === "file") {
    schema = {
      type: "string",
      format: "uri",
      "x-input": "dropzone",
      "x-accept": typeof q.accept === "string" ? q.accept : undefined,
    };
  } else {
    schema = {
      type: "string",
      ...(q.multiline ? { "x-input": "textarea" } : {}),
    };
  }
  if (q.default !== undefined) schema.default = q.default;
  schema.title = title;
  if (subtitle) schema["x-subtitle"] = subtitle;
  return { id, schema, required, title, subtitle };
}

/* ─── Question section ──────────────────────────────────────── */

function QuestionSection({
  question, value, onChange, onSubmitShortcut,
}: {
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  onSubmitShortcut: () => void;
}) {
  const kind = detectKind(question.schema);
  // The per-field "Other" toggle bypasses the structured input on
  // non-enum / non-text kinds. Enums get the per-option Other (inline
  // textarea below the chips); text is already freeform so the toggle
  // is meaningless there.
  const canSwitchToOther = kind === "number" || kind === "boolean" || kind === "dropzone";
  const [otherMode, setOtherMode] = useState(false);
  const effectiveKind: FieldKind = otherMode ? "textarea" : kind;

  // Other-text state for non-enum "Other" toggle: when otherMode is on,
  // we treat `value` as the freeform string directly.
  const onOtherToggle = () => {
    setOtherMode((prev) => {
      const next = !prev;
      // Reset value to a sane default for the new mode so validity behaves.
      onChange(next ? "" : initialValue(question.schema));
      return next;
    });
  };

  return (
    <div className={s.elicitSection}>
      {question.title && (
        <div className={s.elicitSectionTitle}>{question.title}</div>
      )}
      {question.subtitle && (
        <div className={s.elicitSectionSubtitle}>{question.subtitle}</div>
      )}

      {effectiveKind === "enum-single" && (
        <EnumSingle
          field={question.schema}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v)}
        />
      )}

      {effectiveKind === "enum-multi" && (
        <EnumMulti
          field={question.schema}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={(v) => onChange(v)}
        />
      )}

      {effectiveKind === "svg-options" && (
        <SvgOptions
          field={question.schema}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v)}
        />
      )}

      {effectiveKind === "number" && (
        <NumberInput
          field={question.schema}
          value={value}
          onChange={(v) => onChange(v)}
          required={question.required}
        />
      )}

      {effectiveKind === "boolean" && (
        <BooleanToggle
          value={value}
          onChange={(v) => onChange(v)}
          required={question.required}
        />
      )}

      {effectiveKind === "dropzone" && (
        <DropZoneField
          field={question.schema}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v)}
        />
      )}

      {(effectiveKind === "textarea" || effectiveKind === "text") && (
        <PasteableTextarea
          questionId={question.id}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v)}
          multiline={effectiveKind === "textarea"}
          onSubmit={onSubmitShortcut}
        />
      )}

      {canSwitchToOther && (
        <button
          type="button"
          className={s.elicitTextToggle}
          onClick={onOtherToggle}
        >
          {otherMode ? "← Back" : "Other"}
        </button>
      )}
    </div>
  );
}

/* ─── Sub-controls ──────────────────────────────────────────── */

/** Single-select chips with an optional "Other" inline textarea.
 *  When the field schema has `x-other-input: true`:
 *  - "Other" appears in the option list (placed there by the MCP server)
 *  - Selecting "Other" focuses the inline textarea below
 *  - Typing in the textarea makes that text the answer (REPLACES "Other") */
function EnumSingle({
  field, value, onChange,
}: { field: Schema; value: string; onChange: (v: string) => void }) {
  const allOptions = enumOptions(field);
  const hasOther = !!(field as { ["x-other-input"]?: boolean })?.["x-other-input"];
  const knownOptions = hasOther ? allOptions.filter((o) => o !== "Other") : allOptions;

  // The user is in "Other" mode when:
  //   - they've picked the "Other" chip explicitly (otherActive=true), OR
  //   - the value is non-empty and not in the canonical options list
  //     (e.g. they typed custom text into the Other input).
  // Clicking the Other chip seeds value to the literal "Other" so a
  // user who clicks Other and submits without typing sends a clear
  // sentinel — not an empty string that fails required-validity.
  const [otherActive, setOtherActive] = useState(
    () => hasOther && value !== "" && !knownOptions.includes(value),
  );
  const otherSelected = hasOther && (otherActive || (value === "Other") || (value !== "" && !knownOptions.includes(value)));
  const otherText = otherSelected && value !== "Other" && !knownOptions.includes(value) ? value as string : "";

  // Decide for me / Explore a few / Other are escape hatches — render
  // them with a distinct data-attribute so CSS can mute them slightly
  // (italic, dimmer) so the eye lands on canonical options first.
  const ESCAPE = new Set(["Decide for me", "Explore a few"]);
  return (
    <>
      <div className={s.elicitOptions}>
        {knownOptions.map((opt) => {
          const checked = value === opt && !otherSelected;
          const isEscape = ESCAPE.has(opt);
          return (
            <label
              key={opt}
              className={`${s.elicitOption} ${checked ? s.elicitOptionOn : ""}`}
              data-escape={isEscape ? "true" : undefined}
            >
              <input
                type="radio"
                name="elicit-radio"
                checked={checked}
                onChange={() => { setOtherActive(false); onChange(opt); }}
              />
              <span>{opt}</span>
            </label>
          );
        })}
        {hasOther && (
          <label
            className={`${s.elicitOption} ${otherSelected ? s.elicitOptionOn : ""}`}
            data-escape="true"
          >
            <input
              type="radio"
              name="elicit-radio"
              checked={otherSelected}
              onChange={() => { setOtherActive(true); onChange("Other"); }}
            />
            <span>Other</span>
          </label>
        )}
      </div>
      {hasOther && otherSelected && (
        <input
          type="text"
          className={s.elicitOtherInput}
          autoFocus
          placeholder="Type your own…"
          value={otherText}
          onChange={(e) => {
            setOtherActive(true);
            // Empty input → keep "Other" sentinel; non-empty → use the typed text.
            onChange(e.target.value || "Other");
          }}
        />
      )}
    </>
  );
}

/** Multi-select chips with an optional "Other" inline textarea.
 *  When the user types into Other, that string is added to the answer
 *  array (in place of "Other"). */
function EnumMulti({
  field, value, onChange,
}: { field: Schema; value: string[]; onChange: (v: string[]) => void }) {
  const allOptions = enumOptions(field);
  const hasOther = !!(field as { ["x-other-input"]?: boolean })?.["x-other-input"];
  const knownOptions = hasOther ? allOptions.filter((o) => o !== "Other") : allOptions;
  const knownSet = new Set(knownOptions);

  // Anything in `value` that isn't a canonical option is either the
  // literal "Other" sentinel (user clicked Other but didn't type) or
  // the user's freeform Other text. We collapse them into one
  // "extra" string for display purposes.
  const extra = value.find((v) => !knownSet.has(v)) ?? "";
  const otherText = extra && extra !== "Other" ? extra : "";
  const [otherActive, setOtherActive] = useState(() => hasOther && extra !== "");
  const otherSelected = hasOther && (otherActive || extra !== "");

  const knownChosen = value.filter((v) => knownSet.has(v));

  // Mutate `value` in place so the otherText (if any) keeps its
  // relative position. The previous always-append-at-end shape was
  // correct on the wire, but caused the model to see the array
  // re-order on every toggle.
  const toggle = (opt: string) => {
    if (value.includes(opt)) {
      onChange(value.filter((v) => v !== opt));
    } else {
      onChange([...value, opt]);
    }
  };

  const setOtherText = (text: string) => {
    setOtherActive(true);
    // Replace whatever extra string is in the array (literal "Other"
    // sentinel OR previous typed text) with the new value. If text
    // is empty, fall back to the "Other" sentinel so a chip click
    // without typing still records a choice.
    const next = text || "Other";
    if (extra) {
      onChange(value.map((v) => (v === extra ? next : v)));
    } else {
      onChange([...value, next]);
    }
  };

  const ESCAPE = new Set(["Decide for me", "Explore a few"]);
  return (
    <>
      <div className={s.elicitOptions}>
        {knownOptions.map((opt) => {
          const checked = knownChosen.includes(opt);
          const isEscape = ESCAPE.has(opt);
          return (
            <label
              key={opt}
              className={`${s.elicitOption} ${checked ? s.elicitOptionOn : ""}`}
              data-escape={isEscape ? "true" : undefined}
            >
              <input type="checkbox" checked={checked} onChange={() => toggle(opt)} />
              <span>{opt}</span>
            </label>
          );
        })}
        {hasOther && (
          <label
            className={`${s.elicitOption} ${otherSelected ? s.elicitOptionOn : ""}`}
            data-escape="true"
          >
            <input
              type="checkbox"
              checked={otherSelected}
              onChange={() => {
                if (otherSelected) {
                  setOtherActive(false);
                  onChange(knownChosen);
                } else {
                  setOtherActive(true);
                  // Seed the array with the "Other" sentinel so
                  // submitting without typing still records the pick.
                  if (!extra) onChange([...value, "Other"]);
                }
              }}
            />
            <span>Other</span>
          </label>
        )}
      </div>
      {hasOther && otherSelected && (
        <input
          type="text"
          className={s.elicitOtherInput}
          autoFocus
          placeholder="Type your own…"
          value={otherText}
          onChange={(e) => setOtherText(e.target.value)}
        />
      )}
    </>
  );
}

/** Strip the obvious XSS vectors out of an inline-SVG option string.
 *  The model is trusted in normal use, but tool_results can echo
 *  user-uploaded content into a future ask_user call — so even a
 *  trusted agent could end up rendering attacker-controlled SVG.
 *  Drops `<script>` blocks and inline event handlers; leaves the
 *  drawing intact otherwise. */
function sanitizeSvg(raw: string): string {
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*"javascript:[^"]*"/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*'javascript:[^']*'/gi, "");
}

/** Visual-options grid — each option is an inline SVG (~80×56). The
 *  wire value is the option's index as a string ("0", "1", …) so the
 *  model can match against `optionLabels[i]`. Decide-for-me / Other
 *  resolve to their literal label strings as in the text-options case. */
function SvgOptions({
  field, value, onChange,
}: { field: Schema; value: string; onChange: (v: string) => void }) {
  const f = (field ?? {}) as {
    enum?: string[];
    ["x-svg-options"]?: string[];
    ["x-svg-labels"]?: string[];
    ["x-other-input"]?: boolean;
  };
  const svgs = Array.isArray(f["x-svg-options"]) ? f["x-svg-options"] : [];
  const labels = Array.isArray(f["x-svg-labels"]) ? f["x-svg-labels"] : [];
  const hasOther = !!f["x-other-input"];

  // Index strings the agent assigned to each SVG option ("0", "1", …).
  // Anything else is either a reserved escape-hatch label or the user's
  // free-text from the Other input — never a numeric "42" misclassified
  // as a valid index (which the previous `Number.isNaN` check let through
  // when the user happened to type digits into Other).
  const indexOptions = svgs.map((_, i) => String(i));
  const isOtherTyped = hasOther && value !== ""
    && !indexOptions.includes(value)
    && value !== "Decide for me";
  const [otherActive, setOtherActive] = useState(() => isOtherTyped);
  const otherSelected = otherActive || isOtherTyped;

  return (
    <>
      <div className={s.elicitSvgGrid}>
        {svgs.map((svg, i) => {
          const idx = String(i);
          const checked = value === idx && !otherSelected;
          return (
            <button
              key={idx}
              type="button"
              className={`${s.elicitSvgCard} ${checked ? s.elicitSvgCardOn : ""}`}
              onClick={() => { setOtherActive(false); onChange(idx); }}
              title={labels[i] ?? `Option ${i + 1}`}
            >
              <span className={s.elicitSvgInner} dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
              <span className={s.elicitSvgLabel}>{labels[i] ?? `Option ${i + 1}`}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`${s.elicitSvgCard} ${value === "Decide for me" && !otherSelected ? s.elicitSvgCardOn : ""}`}
          onClick={() => { setOtherActive(false); onChange("Decide for me"); }}
        >
          <span className={s.elicitSvgInner} aria-hidden>✦</span>
          <span className={s.elicitSvgLabel}>Decide for me</span>
        </button>
        {hasOther && (
          <button
            type="button"
            className={`${s.elicitSvgCard} ${otherSelected ? s.elicitSvgCardOn : ""}`}
            onClick={() => { setOtherActive(true); onChange(""); }}
          >
            <span className={s.elicitSvgInner} aria-hidden>…</span>
            <span className={s.elicitSvgLabel}>Other</span>
          </button>
        )}
      </div>
      {hasOther && otherSelected && (
        <input
          type="text"
          className={s.elicitOtherInput}
          autoFocus
          placeholder="Other…"
          value={isOtherTyped ? value : ""}
          onChange={(e) => { setOtherActive(true); onChange(e.target.value); }}
        />
      )}
    </>
  );
}

function NumberInput({
  field, value, onChange, required,
}: { field: Schema; value: unknown; onChange: (v: number | string) => void; required: boolean }) {
  const f = (field ?? {}) as { minimum?: number; maximum?: number; multipleOf?: number; default?: number };
  const showSlider = typeof f.minimum === "number" && typeof f.maximum === "number";
  // The user has deferred to the agent — value is the literal string,
  // not a number. We freeze the numeric controls to the schema default
  // (or minimum) so the slider has a sensible position to return to
  // if they un-defer.
  const isDeferred = value === "Decide for me";
  const numValue = typeof value === "number" && Number.isFinite(value)
    ? value
    : (typeof f.default === "number" ? f.default : (typeof f.minimum === "number" ? f.minimum : 0));
  return (
    <>
      <div className={s.elicitNumberRow} data-deferred={isDeferred ? "true" : undefined}>
        {showSlider && (
          <input
            type="range"
            className={s.elicitSlider}
            min={f.minimum}
            max={f.maximum}
            step={f.multipleOf ?? 1}
            value={numValue}
            disabled={isDeferred}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        )}
        <input
          type="number"
          className={s.elicitNumber}
          min={f.minimum}
          max={f.maximum}
          step={f.multipleOf ?? "any"}
          value={isDeferred ? "" : (Number.isFinite(numValue) ? numValue : "")}
          disabled={isDeferred}
          placeholder={isDeferred ? "Decide for me" : undefined}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      {required && (
        <button
          type="button"
          className={s.elicitDeferToggle}
          onClick={() => onChange(isDeferred
            ? (typeof f.default === "number" ? f.default : (typeof f.minimum === "number" ? f.minimum : 0))
            : "Decide for me",
          )}
        >
          {isDeferred ? "← Pick a number" : "Decide for me"}
        </button>
      )}
    </>
  );
}

function BooleanToggle({
  value, onChange, required,
}: { value: unknown; onChange: (v: boolean | string) => void; required: boolean }) {
  // Sliding switch with a Yes/No track. Required questions also surface
  // a separate "Decide for me" link below so the user can defer
  // (matches the number-input defer pattern). Optional questions skip
  // the link — they just don't gate Continue if left untouched.
  const isYes = value === true;
  const isNo = value === false;
  const isDefer = value === "Decide for me";
  // The switch shows "unset" visually when no choice has been made
  // (initial state for required booleans). Click anywhere on the
  // track to commit Yes or No; click "Decide for me" to defer.
  const state: "yes" | "no" | "unset" | "defer" = isYes ? "yes" : isNo ? "no" : isDefer ? "defer" : "unset";
  return (
    <div className={s.elicitBoolean}>
      <button
        type="button"
        className={s.elicitSwitch}
        role="switch"
        aria-checked={isYes}
        data-state={state}
        onClick={() => onChange(!isYes)}
        title={isYes ? "Yes — click to flip to No" : isNo ? "No — click to flip to Yes" : "Click to set Yes"}
      >
        <span className={s.elicitSwitchTrack}>
          <span className={s.elicitSwitchThumb} aria-hidden />
        </span>
        <span className={s.elicitSwitchLabel}>
          {state === "yes" ? "Yes" : state === "no" ? "No" : state === "defer" ? "Decide for me" : "—"}
        </span>
      </button>
      {required && (
        <button
          type="button"
          className={s.elicitDeferToggle}
          onClick={() => onChange(isDefer ? false : "Decide for me")}
        >
          {isDefer ? "← Pick Yes / No" : "Decide for me"}
        </button>
      )}
    </div>
  );
}

function DropZoneField({
  field, value, onChange,
}: { field: Schema; value: string; onChange: (v: string) => void }) {
  const accept = (field as { ["x-accept"]?: string })?.["x-accept"] ?? null;
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(r.error ?? new Error("read failed"));
        r.readAsDataURL(file);
      });
      const stamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const target = `public/uploads/elicit-${stamp}-${safeName}`;
      const res = await fetch("/api/file/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, dataUrl }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { path: string };
      onChange(j.path);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`${s.elicitDropzone} ${dragOver ? s.elicitDropzoneActive : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) upload(f);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept ?? undefined}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      {value ? (
        <div className={s.elicitDropzonePath}>
          <strong>Saved:</strong> {value}
        </div>
      ) : busy ? (
        <div>Uploading…</div>
      ) : (
        <div>
          <div>Drop a file or click to pick{accept ? ` (${accept})` : ""}</div>
        </div>
      )}
      {err && <div className={s.elicitError}>{err}</div>}
    </div>
  );
}

/**
 * Auto-growing textarea that also accepts pasted/dropped images.
 *
 * Each uploaded image is appended to the answer text as a markdown
 * image reference (`![](path)`) so Claude can Read each path. This
 * keeps the schema flat (single string) while still passing file
 * paths through.
 */
function PasteableTextarea({
  questionId, value, onChange, multiline, onSubmit,
}: {
  questionId: string;
  value: string;
  onChange: (v: string) => void;
  multiline: boolean;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-resize: 1 line min, 8 lines max for multiline; 4 lines max for "text".
  const maxPx = multiline ? 200 : 110;
  const onResize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxPx) + "px";
  };

  // Re-measure after the value changes (incl. external mutations like
  // pasted images appending markdown). Using `useLayoutEffect` keeps
  // the resize synchronous with paint so the textarea doesn't flicker
  // between its old and new heights.
  useLayoutEffect(() => {
    onResize();
    // onResize reads only `ref.current` and `maxPx` (closed over), so
    // the deps array can stay value-only — eslint-react would warn
    // about onResize, but it's stable enough across renders that we
    // don't need to reify it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, maxPx]);

  const uploadAndAppend = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(r.error ?? new Error("read failed"));
        r.readAsDataURL(file);
      });
      const stamp = Date.now();
      const safeName = (file.name || "image.png").replace(/[^a-zA-Z0-9._-]+/g, "-");
      const target = `public/uploads/elicit-${stamp}-${safeName}`;
      const res = await fetch("/api/file/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, dataUrl }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { path: string };
      const ref = `![](${j.path})`;
      onChange(value.trim() ? `${value}\n\n${ref}` : ref);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div
      className={`${s.elicitTextareaWrap} ${dragOver ? s.elicitTextareaDrag : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        for (const f of files) await uploadAndAppend(f);
      }}
    >
      <textarea
        ref={ref}
        className={s.elicitTextarea}
        name={questionId}
        value={value}
        onChange={(e) => { onChange(e.target.value); onResize(); }}
        onInput={onResize}
        onPaste={async (e) => {
          const items = Array.from(e.clipboardData.items).filter((it) => it.type.startsWith("image/"));
          if (items.length === 0) return;
          e.preventDefault();
          const files = items.map((it) => it.getAsFile()).filter((f): f is File => f != null);
          for (const f of files) await uploadAndAppend(f);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={busy ? "Uploading image…" : "Type, ⌘V to paste an image, or drop a file"}
        rows={multiline ? 4 : 2}
        style={{ maxHeight: maxPx }}
      />
      {/* Per-question image-attach trigger — same upload path as
       *  paste/drop, just visible. Lives in the bottom-right corner
       *  of the textarea so it doesn't compete with the typed text. */}
      <button
        type="button"
        className={s.elicitTextareaAttach}
        onClick={() => fileInputRef.current?.click()}
        disabled={busy}
        title="Attach an image"
        aria-label="Attach an image"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 4 V11 a3 3 0 0 1 -6 0 V5 a2 2 0 0 1 4 0 V10 a1 1 0 0 1 -2 0 V6" />
        </svg>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
          for (const f of files) await uploadAndAppend(f);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />
      <div className={s.elicitTextareaHint}>
        {busy ? "Uploading…" : "⌘V to paste · drop images · ⌘↵ to send"}
      </div>
      {err && <div className={s.elicitError}>{err}</div>}
    </div>
  );
}

/* ─── Schema helpers ────────────────────────────────────────── */

type FieldKind =
  | "enum-single"
  | "enum-multi"
  | "svg-options"
  | "number"
  | "boolean"
  | "dropzone"
  | "textarea"
  | "text";

function parseQuestions(schema: Schema): Question[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: Record<string, Schema> }).properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(
    Array.isArray((schema as { required?: string[] }).required)
      ? ((schema as { required?: string[] }).required as string[])
      : [],
  );
  const out: Question[] = [];
  for (const [id, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema || typeof fieldSchema !== "object") continue;
    const f = fieldSchema as { title?: string; ["x-subtitle"]?: string };
    out.push({
      id,
      schema: fieldSchema,
      required: required.has(id),
      title: typeof f.title === "string" ? f.title : id,
      subtitle: typeof f["x-subtitle"] === "string" ? f["x-subtitle"] : undefined,
    });
  }
  return out;
}

function detectKind(field: Schema): FieldKind {
  if (!field || typeof field !== "object") return "text";
  const f = field as {
    type?: string;
    enum?: string[];
    items?: { enum?: string[] };
    ["x-options"]?: string[];
    ["x-input"]?: string;
    format?: string;
  };
  if (f.type === "string" && f["x-input"] === "svg-options") return "svg-options";
  // x-options OR enum (legacy) on string array → multi-select chips.
  if (f.type === "array" && (Array.isArray(f["x-options"]) || Array.isArray(f.items?.enum))) return "enum-multi";
  if (Array.isArray(f["x-options"]) || Array.isArray(f.enum)) return "enum-single";
  if (f.type === "number" || f.type === "integer") return "number";
  if (f.type === "boolean") return "boolean";
  if (f.type === "string") {
    if (f["x-input"] === "dropzone" || f.format === "uri") return "dropzone";
    if (f["x-input"] === "textarea") return "textarea";
    return "text";
  }
  return "text";
}

/** Read the option list from x-options (preferred — used when the
 *  schema also accepts free-form Other text) or from enum (legacy
 *  strict-validated path, kept for backwards compat). */
function enumOptions(field: Schema): string[] {
  if (!field || typeof field !== "object") return [];
  const f = field as { enum?: string[]; items?: { enum?: string[] }; ["x-options"]?: string[] };
  if (Array.isArray(f["x-options"])) return f["x-options"];
  if (Array.isArray(f.enum)) return f.enum;
  if (Array.isArray(f.items?.enum)) return f.items.enum;
  return [];
}

function initialValue(schema: Schema): unknown {
  const kind = detectKind(schema);
  const f = (schema ?? {}) as { default?: unknown; minimum?: number };
  switch (kind) {
    case "enum-single": return typeof f.default === "string" ? f.default : "";
    case "enum-multi":  return Array.isArray(f.default) ? f.default : [];
    case "svg-options": return typeof f.default === "string" ? f.default : "";
    case "number":
      if (typeof f.default === "number") return f.default;
      if (typeof f.minimum === "number") return f.minimum;
      return 0;
    // Initial undefined for boolean so the user has to explicitly
    // pick (Yes / No / Decide for me) on required questions. A
    // pre-selected `false` would silently submit "No" if Continue
    // was clicked without interacting with the toggle.
    case "boolean":     return typeof f.default === "boolean" ? f.default : undefined;
    case "dropzone":    return typeof f.default === "string" ? f.default : "";
    case "textarea":
    case "text":        return typeof f.default === "string" ? f.default : "";
  }
}

function isValid(schema: Schema, value: unknown): boolean {
  const kind = detectKind(schema);
  // "Decide for me" is a valid sentinel for any kind that auto-injects
  // the defer affordance; it satisfies the required check identically
  // to a real answer.
  if (value === "Decide for me") return true;
  switch (kind) {
    case "enum-single": return typeof value === "string" && value.length > 0;
    case "enum-multi":  return Array.isArray(value) && value.length > 0;
    case "svg-options": return typeof value === "string" && value.length > 0;
    case "number":      return typeof value === "number" && Number.isFinite(value);
    // Required boolean questions need an explicit pick (incl. defer).
    // Once we're here without "Decide for me", the value must be a
    // real boolean.
    case "boolean":     return typeof value === "boolean";
    case "dropzone":    return typeof value === "string" && value.length > 0;
    case "textarea":
    case "text":        return typeof value === "string" && value.trim().length > 0;
  }
}
