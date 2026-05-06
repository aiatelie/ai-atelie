/* ModelPicker.tsx — reusable model selector used in ChatSidebar,
 * CommentBubble, and Inspector. */

import { useMemo, useState } from "react";
import s from "./modelPicker.module.css";
import { MODEL_PRESETS, DEFAULT_MODEL_ID, presetsByTier, getModel, mergeAgentModels } from "../../data/modelPresets";
import { useAgents } from "../../data/agents";
import { useFlag } from "../../lib/flags";
import { AdaptersDialog } from "./AdaptersDialog";

export function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const [adaptersOpen, setAdaptersOpen] = useState(false);
  const agents = useAgents();
  // Surface "needs setup" affordance only when at least one adapter is
  // not ready — avoids cluttering the dropdown when everything works.
  const needsSetup = agents.some((a) => !a.installed || a.authRequired);
  // Merge static Claude/Kimi presets with dynamic OpenCode models
  // (sourced from `opencode models` server-side, served via /api/agents).
  // Recomputes once when agents resolve, then memoized.
  const presets = useMemo(() => mergeAgentModels(agents), [agents]);
  const tiers = presetsByTier(presets);
  // The picker's selected-state lookup must use the merged list so a
  // saved OpenCode id (e.g. "anthropic/claude-sonnet-4-5") doesn't
  // fall through to MODEL_PRESETS[0]. Synthesize a placeholder when
  // agents haven't resolved yet AND the saved id isn't in the static
  // list — the picker chip just shows the raw id until hydration.
  const current = getModel(value, presets)
    ?? (value ? { id: value, label: value, provider: "opencode" as const, tier: "secondary" as const } : presets[0]);

  return (
    <div className={s.modelPicker}>
      <button
        type="button"
        className={s.modelPickerButton}
        data-testid="model-selector-button"
        onClick={() => setOpen((o) => !o)}
        title="Change model"
      >
        <span className={s.modelDot} data-provider={current.provider} />
        {current.label}
        <span className={s.modelChev}>▾</span>
      </button>
      {open && (
        <div className={s.modelMenu}>
          <ModelGroup label="Recommended" items={tiers.primary} value={value} onPick={(id) => { onChange(id); setOpen(false); }} />
          {tiers.secondary.length > 0 && (
            <ModelGroup label="Other" items={tiers.secondary} value={value} onPick={(id) => { onChange(id); setOpen(false); }} />
          )}
          {tiers.legacy.length > 0 && (
            <>
              <button
                type="button"
                className={s.modelLegacyToggle}
                onClick={() => setShowLegacy((s) => !s)}
              >
                {showLegacy ? "Hide" : "Show"} older models
              </button>
              {showLegacy && (
                <ModelGroup label="Legacy" items={tiers.legacy} value={value} onPick={(id) => { onChange(id); setOpen(false); }} />
              )}
            </>
          )}
          <button
            type="button"
            className={s.modelLegacyToggle}
            onClick={() => { setOpen(false); setAdaptersOpen(true); }}
          >
            ⚙ Manage adapters{needsSetup ? " · setup needed" : ""}
          </button>
        </div>
      )}
      <AdaptersDialog open={adaptersOpen} onClose={() => setAdaptersOpen(false)} />
    </div>
  );
}

function ModelGroup({
  label,
  items,
  value,
  onPick,
}: {
  label: string;
  items: { id: string; label: string; description?: string; provider: string; supportsAdaptiveThinking?: boolean }[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className={s.modelGroup}>
      <div className={s.modelGroupLabel}>{label}</div>
      {items.map((m) => (
        <button
          key={m.id}
          type="button"
          className={s.modelItem}
          aria-pressed={m.id === value}
          onClick={() => onPick(m.id)}
        >
          <span className={s.modelDot} data-provider={m.provider} />
          <span className={s.modelLabelCol}>
            <span className={s.modelItemLabel}>
              {m.label}
              {m.supportsAdaptiveThinking && <span className={s.modelBadge}>thinking</span>}
            </span>
            {m.description && <span className={s.modelItemDesc}>{m.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function useModelPickerFlag(): boolean {
  return useFlag("model-picker");
}

export function loadModelId(): string {
  if (typeof window === "undefined") return DEFAULT_MODEL_ID;
  try {
    const saved = localStorage.getItem("editor-model-id");
    if (!saved) return DEFAULT_MODEL_ID;
    // Static-list match → trusted. Otherwise pass through (it might
    // be a dynamic OpenCode `provider/model` id we can't validate
    // synchronously; the server's pickAdapter() rejects truly-invalid
    // ids cleanly). Strict validation moved to the picker, which
    // re-renders once agents resolve.
    return saved;
  } catch { return DEFAULT_MODEL_ID; }
}

export function saveModelId(id: string) {
  try { localStorage.setItem("editor-model-id", id); } catch { /* ignore */ }
}
