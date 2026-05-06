/* ElicitForm.tsx — renders an MCP elicitation form inside the chat sidebar.
 *
 * The dev server emits an `elicit` SSE event when Claude calls ask_user
 * (mcp/ask-user-server.mjs). We surface a structured form for the user to
 * fill, then POST the answer to /api/elicit-response so the server resolves
 * the pending elicitation and Claude can continue.
 *
 * Schema shape we expect (built by mcp/ask-user-server.mjs):
 *   { type: "object", properties: { answer: <field> }, required: ["answer"] }
 *
 * Field kinds we support (single answer field — keep it simple):
 *   - enum single  → radio        { type:"string", enum:[…] }
 *   - enum multi   → checkbox     { type:"array",  items:{ type:"string", enum:[…] } }
 *   - number       → range/slider { type:"number", minimum, maximum, multipleOf }
 *   - boolean      → toggle       { type:"boolean" }
 *   - dropzone     → file drop    { type:"string", format:"uri", "x-input":"dropzone" }
 *   - textarea     → textarea     { type:"string", "x-input":"textarea" }
 *   - string       → text input   { type:"string" }
 */

import { useRef, useState } from "react";
import s from "./chat.module.css";
import type { ElicitRequest } from "../../lib/chatStream";

type Schema = Record<string, unknown> | undefined;

type Props = {
  request: ElicitRequest;
  /** Called once the user submits / declines / cancels. */
  onResolved: () => void;
};

export function ElicitForm({ request, onResolved }: Props) {
  const answerField = getAnswerField(request.schema);
  const detectedKind = detectKind(answerField);
  // "Type freely" toggle — lets the user bypass the structured input and
  // write a freeform answer regardless of the field kind. Useful when the
  // model's options don't quite cover what the user wants to say.
  const canTypeFreely = detectedKind !== "text" && detectedKind !== "textarea";
  const [freeMode, setFreeMode] = useState(false);
  const kind: FieldKind = freeMode ? "textarea" : detectedKind;

  // One value type per kind — keep them in separate state slots.
  const [single, setSingle] = useState<string>(() => initialString(answerField));
  const [multi, setMulti] = useState<string[]>(() => initialArray(answerField));
  const [num, setNum] = useState<number>(() => initialNumber(answerField));
  const [bool, setBool] = useState<boolean>(() => initialBoolean(answerField));
  const [text, setText] = useState<string>(() => initialString(answerField));
  /** Pasted/dropped images for text/textarea fields. Rendered as chips
   *  above the textarea (composer-style); appended to the answer as
   *  markdown image references on submit so Claude can Read each path. */
  const [textAttachments, setTextAttachments] = useState<{ path: string; dataUrl: string }[]>([]);
  const [dropPath, setDropPath] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const valid = (() => {
    switch (kind) {
      case "enum-single": return !!single;
      case "enum-multi":  return multi.length > 0;
      case "number":      return Number.isFinite(num);
      case "boolean":     return true;
      case "dropzone":    return !!dropPath;
      case "textarea":
      case "text":        return text.trim().length > 0 || textAttachments.length > 0;
      default:            return text.trim().length > 0;
    }
  })();

  const buildAnswer = (): unknown => {
    switch (kind) {
      case "enum-single": return single;
      case "enum-multi":  return multi;
      case "number":      return num;
      case "boolean":     return bool;
      case "dropzone":    return dropPath;
      case "textarea":
      case "text": {
        // Append attachments as markdown image refs so Claude can Read
        // each path. Keeps the textarea visually clean while still
        // delivering the file references through the single-string
        // elicitation answer field.
        if (textAttachments.length === 0) return text;
        const refs = textAttachments.map((a) => `![](${a.path})`).join("\n");
        return text.trim() ? `${text}\n\n${refs}` : refs;
      }
      default:            return text;
    }
  };

  const send = async (action: "accept" | "decline" | "cancel") => {
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    const body: { id: string; action: string; content?: { answer: unknown } } = {
      id: request.id,
      action,
    };
    if (action === "accept") body.content = { answer: buildAnswer() };
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
      onResolved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className={s.elicitCard}>
      <div className={s.elicitHeader}>
        <span className={s.elicitDot} />
        <span className={s.elicitTitle}>{request.message}</span>
      </div>

      <div className={s.elicitBody}>
        {kind === "enum-single" && (
          <RadioGroup
            options={enumOptions(answerField)}
            value={single}
            onChange={setSingle}
          />
        )}

        {kind === "enum-multi" && (
          <CheckboxGroup
            options={enumOptions(answerField)}
            value={multi}
            onChange={setMulti}
          />
        )}

        {kind === "number" && (
          <NumberInput
            field={answerField}
            value={num}
            onChange={setNum}
          />
        )}

        {kind === "boolean" && (
          <BooleanToggle value={bool} onChange={setBool} />
        )}

        {kind === "dropzone" && (
          <DropZone
            accept={(answerField as { ["x-accept"]?: string })?.["x-accept"] ?? null}
            value={dropPath}
            onPath={setDropPath}
            dragOver={dragOver}
            setDragOver={setDragOver}
          />
        )}

        {(kind === "textarea" || kind === "text") && (
          <PasteableTextarea
            value={text}
            onChange={setText}
            attachments={textAttachments}
            onAttachmentsChange={setTextAttachments}
            multiline={kind === "textarea"}
            onSubmit={() => { if (valid) send("accept"); }}
          />
        )}
      </div>

      {errorMsg && <div className={s.elicitError}>{errorMsg}</div>}

      <div className={s.elicitActions}>
        {canTypeFreely && (
          <button
            type="button"
            className={s.elicitTextToggle}
            onClick={() => setFreeMode((v) => !v)}
            disabled={submitting}
          >
            {freeMode ? "← Use the form" : "Type freely instead"}
          </button>
        )}
        <div className={s.elicitActionsSpacer} />
        <button
          className={s.elicitBtn}
          onClick={() => send("cancel")}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          className={`${s.elicitBtn} ${s.elicitPrimary}`}
          onClick={() => send("accept")}
          disabled={!valid || submitting}
        >
          {submitting ? "Sending…" : "Send answer"}
        </button>
      </div>
    </div>
  );
}

/* ─── Sub-controls ──────────────────────────────────────────── */

function RadioGroup({
  options, value, onChange,
}: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className={s.elicitOptions}>
      {options.map((opt) => (
        <label key={opt} className={`${s.elicitOption} ${value === opt ? s.elicitOptionOn : ""}`}>
          <input
            type="radio"
            name="elicit-radio"
            checked={value === opt}
            onChange={() => onChange(opt)}
          />
          <span>{opt}</span>
        </label>
      ))}
    </div>
  );
}

function CheckboxGroup({
  options, value, onChange,
}: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (opt: string) => {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else onChange([...value, opt]);
  };
  return (
    <div className={s.elicitOptions}>
      {options.map((opt) => (
        <label key={opt} className={`${s.elicitOption} ${value.includes(opt) ? s.elicitOptionOn : ""}`}>
          <input
            type="checkbox"
            checked={value.includes(opt)}
            onChange={() => toggle(opt)}
          />
          <span>{opt}</span>
        </label>
      ))}
    </div>
  );
}

function NumberInput({
  field, value, onChange,
}: { field: Schema; value: number; onChange: (v: number) => void }) {
  const f = (field ?? {}) as { minimum?: number; maximum?: number; multipleOf?: number };
  const showSlider = typeof f.minimum === "number" && typeof f.maximum === "number";
  return (
    <div className={s.elicitNumberRow}>
      {showSlider && (
        <input
          type="range"
          className={s.elicitSlider}
          min={f.minimum}
          max={f.maximum}
          step={f.multipleOf ?? 1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      <input
        type="number"
        className={s.elicitNumber}
        min={f.minimum}
        max={f.maximum}
        step={f.multipleOf ?? "any"}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/**
 * Auto-growing textarea that also accepts pasted/dropped images.
 *
 * Each uploaded image is added to the `attachments` array (rendered as
 * a small chip above the textarea, composer-style — × to remove) rather
 * than inserted into the text as raw markdown. ElicitForm appends the
 * markdown refs to the answer string at submit time so the textarea
 * stays clean while the file paths still reach Claude.
 */
function PasteableTextarea({
  value, onChange, attachments, onAttachmentsChange, multiline, onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  attachments: { path: string; dataUrl: string }[];
  onAttachmentsChange: (next: { path: string; dataUrl: string }[]) => void;
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

  // Resize when value changes from the outside.
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(onResize);
  }

  const uploadAndAttach = async (file: File) => {
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
      onAttachmentsChange([...attachments, { path: j.path, dataUrl }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = (idx: number) => {
    onAttachmentsChange(attachments.filter((_, i) => i !== idx));
  };

  return (
    <div
      className={`${s.elicitTextareaWrap} ${dragOver ? s.elicitTextareaDrag : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        for (const f of files) await uploadAndAttach(f);
      }}
    >
      {attachments.length > 0 && (
        <div className={s.elicitAttaches}>
          {attachments.map((a, i) => (
            <div key={a.path} className={s.elicitAttachItem} title={a.path}>
              <img src={a.dataUrl} alt="" />
              <button
                type="button"
                className={s.elicitAttachRemove}
                onClick={() => removeAttachment(i)}
                aria-label="Remove attachment"
              >×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className={s.elicitTextarea}
        value={value}
        onChange={(e) => { onChange(e.target.value); onResize(); }}
        onInput={onResize}
        onPaste={async (e) => {
          const items = Array.from(e.clipboardData.items).filter((it) => it.type.startsWith("image/"));
          if (items.length === 0) return;
          e.preventDefault();
          const files = items.map((it) => it.getAsFile()).filter((f): f is File => f != null);
          for (const f of files) await uploadAndAttach(f);
        }}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter sends; plain Enter inserts newline (matches
          // the chat composer where Enter sends, but here multi-line is
          // the default so the inverted behavior is safer).
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={busy ? "Uploading image…" : "Type, ⌘V to paste an image, or drop a file"}
        autoFocus
        rows={multiline ? 4 : 2}
        style={{ maxHeight: maxPx }}
      />
      <div className={s.elicitTextareaHint}>
        {busy ? "Uploading…" : "⌘V to paste · drop images · ⌘↵ to send"}
      </div>
      {err && <div className={s.elicitError}>{err}</div>}
    </div>
  );
}

function BooleanToggle({
  value, onChange,
}: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={s.elicitOptions}>
      <label className={`${s.elicitOption} ${value === true  ? s.elicitOptionOn : ""}`}>
        <input type="radio" checked={value === true}  onChange={() => onChange(true)} /><span>Yes</span>
      </label>
      <label className={`${s.elicitOption} ${value === false ? s.elicitOptionOn : ""}`}>
        <input type="radio" checked={value === false} onChange={() => onChange(false)} /><span>No</span>
      </label>
    </div>
  );
}

function DropZone({
  accept, value, onPath, dragOver, setDragOver,
}: {
  accept: string | null;
  value: string;
  onPath: (path: string) => void;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
}) {
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
      onPath(j.path);
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

/* ─── Schema helpers ────────────────────────────────────────── */

type FieldKind = "enum-single" | "enum-multi" | "number" | "boolean" | "dropzone" | "textarea" | "text";

function getAnswerField(schema: Schema): Schema {
  if (!schema || typeof schema !== "object") return undefined;
  const props = (schema as { properties?: Record<string, Schema> }).properties;
  return props?.answer;
}

function detectKind(field: Schema): FieldKind {
  if (!field || typeof field !== "object") return "text";
  const f = field as { type?: string; enum?: string[]; items?: { enum?: string[] }; ["x-input"]?: string; format?: string };
  if (f.type === "array" && Array.isArray(f.items?.enum)) return "enum-multi";
  if (Array.isArray(f.enum)) return "enum-single";
  if (f.type === "number" || f.type === "integer") return "number";
  if (f.type === "boolean") return "boolean";
  if (f.type === "string") {
    if (f["x-input"] === "dropzone" || f.format === "uri") return "dropzone";
    if (f["x-input"] === "textarea") return "textarea";
    return "text";
  }
  return "text";
}

function enumOptions(field: Schema): string[] {
  if (!field || typeof field !== "object") return [];
  const f = field as { enum?: string[]; items?: { enum?: string[] } };
  if (Array.isArray(f.enum)) return f.enum;
  if (Array.isArray(f.items?.enum)) return f.items.enum;
  return [];
}

function initialString(field: Schema): string {
  const d = (field as { default?: unknown } | undefined)?.default;
  return typeof d === "string" ? d : "";
}

function initialArray(field: Schema): string[] {
  const d = (field as { default?: unknown } | undefined)?.default;
  return Array.isArray(d) ? d.filter((v): v is string => typeof v === "string") : [];
}

function initialNumber(field: Schema): number {
  const f = (field ?? {}) as { default?: unknown; minimum?: number };
  if (typeof f.default === "number") return f.default;
  if (typeof f.minimum === "number") return f.minimum;
  return 0;
}

function initialBoolean(field: Schema): boolean {
  const d = (field as { default?: unknown } | undefined)?.default;
  return typeof d === "boolean" ? d : false;
}
