import { test, expect } from "bun:test";
import { SKILLS, buildSkillsPreamble, skillsStorageKey, loadActiveSkills, saveActiveSkills } from "./skills";

// Minimal localStorage shim so the persistence helpers exercise the
// real path under bun's no-DOM test runtime. skills.ts gates its IO
// behind `typeof window === "undefined"` so we have to stub `window`
// too — otherwise load/save bail early and the round-trip silently
// returns []. Single shared store across the test file is fine.
function installLocalStorageShim() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as Storage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = ls;
  (globalThis as unknown as { window: { localStorage: Storage } }).window = { localStorage: ls };
}

test("SKILLS catalog ships the expected five chips", () => {
  const ids = SKILLS.map((s) => s.id);
  // `posture-frontend-design` (not `frontend-design`) — the chip's id
  // is deliberately distinct from the catalog skill of the same name
  // in api DEFAULT_ACTIVE_SKILLS so the prompt isn't injected twice.
  expect(ids).toEqual(["wireframe", "hifi", "interactive", "posture-frontend-design", "tweakable"]);
  for (const sk of SKILLS) {
    expect(sk.label.length).toBeGreaterThan(0);
    expect(sk.prompt.length).toBeGreaterThan(20);
    expect(sk.color).toMatch(/^#[0-9A-F]{6}$/i);
  }
});

test("chip labels don't collide with the manifest active-skills strip", () => {
  // The ActiveSkillsStrip renders project-manifest aesthetic skills
  // ("Frontend design", "Aesthetic presets", "Design critique",
  // "DESIGN.md author"). If a composer chip shares one of those labels,
  // the user sees two identical-looking pills stacked above the
  // composer — confusing because they're wired to different code paths.
  // Keep the chip labels disjoint.
  const manifestSkillLabels = new Set([
    "Frontend design",
    "Aesthetic presets",
    "Design critique",
    "DESIGN.md author",
  ]);
  for (const sk of SKILLS) {
    expect(manifestSkillLabels.has(sk.label)).toBe(false);
  }
});

test("buildSkillsPreamble returns undefined when no chips are active", () => {
  expect(buildSkillsPreamble([])).toBeUndefined();
});

test("buildSkillsPreamble silently drops unknown ids", () => {
  // Stale localStorage from a previous bundle that referenced a
  // since-removed skill must NOT crash the send.
  expect(buildSkillsPreamble(["does-not-exist"])).toBeUndefined();
});

test("buildSkillsPreamble joins multiple skills with the active-skills header", () => {
  const out = buildSkillsPreamble(["wireframe", "hifi"]);
  expect(out).toBeDefined();
  expect(out!).toContain("[Active skills: wireframe, hifi]");
  expect(out!).toContain("### Wireframe");
  expect(out!).toContain("### High fidelity");
});

test("skillsStorageKey is per-project and falls back when missing", () => {
  expect(skillsStorageKey("abc-123")).toBe("composer-skills:abc-123");
  expect(skillsStorageKey(undefined)).toBe("composer-skills:_default");
});

test("save / load round-trips active skill ids", () => {
  installLocalStorageShim();
  saveActiveSkills("p1", ["wireframe", "hifi"]);
  expect(loadActiveSkills("p1")).toEqual(["wireframe", "hifi"]);
  // Empty array clears the key (no dead "[]" rows).
  saveActiveSkills("p1", []);
  expect(loadActiveSkills("p1")).toEqual([]);
});

test("load defends against malformed storage values", () => {
  installLocalStorageShim();
  // Hand-write a non-array value as if a previous version stored a
  // string instead. Must not crash.
  localStorage.setItem("composer-skills:p2", '"hifi"');
  expect(loadActiveSkills("p2")).toEqual([]);
  localStorage.setItem("composer-skills:p2", "{ not: 'json' ");
  expect(loadActiveSkills("p2")).toEqual([]);
});
