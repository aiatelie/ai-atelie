#!/usr/bin/env node
/* Theme generator — emits CSS variable overrides for each theme palette.
 *
 * Add a palette to PALETTES, run `node tools/gen-themes.mjs`, and the
 * matching `:root[data-theme="<id>"]` block lands in
 * web/src/styles/themes.css. The light/dark/retro tokens already living
 * in web/src/index.css are the reference shape — every var that exists
 * in those blocks is regenerated here per palette.
 *
 * Palettes are inspired by public design-system writeups; names in code
 * are descriptive (Violet, Mono, Vinyl, …) rather than brand-named. */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "web", "src", "styles", "themes.css");

/* ─── Helpers ─────────────────────────────────────────────── */

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* The alpha scale used for `--ink-XX`. On light themes the suffix
 * matches the alpha (ink-02 = 0.02). On dark themes the perceptual
 * weight of a dark overlay shifts, so we use a bumped scale that
 * mirrors the existing Dark override in web/src/index.css. */
const INK_ALPHAS_LIGHT = {
  "02": 0.02, "04": 0.04, "05": 0.05, "06": 0.06, "08": 0.08,
  "10": 0.10, "12": 0.12, "15": 0.15, "20": 0.20, "25": 0.25,
  "30": 0.30, "35": 0.35, "40": 0.40, "44": 0.44, "50": 0.50,
  "55": 0.55, "60": 0.60, "64": 0.64, "65": 0.65, "70": 0.70,
  "78": 0.78, "85": 0.85, "92": 0.92,
};
const INK_ALPHAS_DARK = {
  "02": 0.04, "04": 0.06, "05": 0.07, "06": 0.08, "08": 0.10,
  "10": 0.12, "12": 0.14, "15": 0.18, "20": 0.24, "25": 0.28,
  "30": 0.34, "35": 0.40, "40": 0.46, "44": 0.50, "50": 0.56,
  "55": 0.62, "60": 0.68, "64": 0.72, "65": 0.74, "70": 0.80,
  "78": 0.86, "85": 0.90, "92": 0.95,
};
/* Cream/warm light themes need a small bump too — Retro's pattern. */
const INK_ALPHAS_WARM = {
  "02": 0.025, "04": 0.05, "05": 0.06, "06": 0.07, "08": 0.10,
  "10": 0.12, "12": 0.14, "15": 0.18, "20": 0.22, "25": 0.28,
  "30": 0.34, "35": 0.38, "40": 0.44, "44": 0.48, "50": 0.54,
  "55": 0.58, "60": 0.62, "64": 0.66, "65": 0.68, "70": 0.72,
  "78": 0.80, "85": 0.86, "92": 0.92,
};

const ON_INK_ALPHAS = {
  "06": 0.06, "08": 0.08, "10": 0.10, "12": 0.12, "15": 0.15,
  "18": 0.18, "20": 0.20, "25": 0.25, "30": 0.30, "40": 0.40,
  "50": 0.50, "55": 0.55, "60": 0.60, "65": 0.65, "70": 0.70,
  "80": 0.80, "85": 0.85, "90": 0.90,
};

/* ─── Palettes ─────────────────────────────────────────────
 * Each entry only specifies the source colors — surfaces, ink, brand,
 * a swatch for the picker preview. Everything else is derived. */

export const PALETTES = [
  {
    id: "violet",
    label: "Violet",
    description: "Deep navy ink on white with a saturated violet accent.",
    kind: "light",
    bg: "#ffffff",
    surface: "#ffffff",
    surface2: "#f4f3fb",
    surface3: "#fafafd",
    surface4: "#eeecf8",
    surfaceWarm: "#f7f6fc",
    ink: "#061b31",
    onInk: "#ffffff",
    brand: "#533afd",
    brandLight: "#b9b9f9",
    brandWarm: "#f96bee",
    brandWarmStrong: "#ea2261",
    swatch: ["#ffffff", "#f4f3fb", "#533afd", "#061b31"],
  },
  {
    id: "mono",
    label: "Mono",
    description: "Stark black ink on white. No chromatic accent.",
    kind: "light",
    bg: "#ffffff",
    surface: "#ffffff",
    surface2: "#fafafa",
    surface3: "#fbfbfb",
    surface4: "#f5f5f5",
    surfaceWarm: "#f7f7f7",
    ink: "#171717",
    onInk: "#ffffff",
    brand: "#171717",
    brandLight: "#666666",
    brandWarm: "#ff5b4f",
    brandWarmStrong: "#de1d8d",
    swatch: ["#ffffff", "#ebebeb", "#171717", "#666666"],
  },
  {
    id: "paper",
    label: "Paper",
    description: "Warm cream paper, charcoal ink, plum accent.",
    kind: "warm",
    bg: "#fafaf9",
    surface: "#ffffff",
    surface2: "#f6f5f4",
    surface3: "#fafaf9",
    surface4: "#f0eeec",
    surfaceWarm: "#ede9e4",
    ink: "#37352f",
    onInk: "#ffffff",
    brand: "#7b3ff2",
    brandLight: "#d6b6f6",
    brandWarm: "#ff64c8",
    brandWarmStrong: "#a02e6d",
    swatch: ["#fafaf9", "#f6f5f4", "#7b3ff2", "#37352f"],
  },
  {
    id: "espresso",
    label: "Espresso",
    description: "Coffeehouse cream, dark forest green ink and accent.",
    kind: "warm",
    bg: "#f2f0eb",
    surface: "#ffffff",
    surface2: "#edebe9",
    surface3: "#faf6ee",
    surface4: "#e8e5dd",
    surfaceWarm: "#ede9e4",
    ink: "#1e3932",
    onInk: "#ffffff",
    brand: "#006241",
    brandLight: "#d4e9e2",
    brandWarm: "#cba258",
    brandWarmStrong: "#c82014",
    swatch: ["#f2f0eb", "#ffffff", "#006241", "#1e3932"],
  },
  {
    id: "coral",
    label: "Coral",
    description: "Cool cream surfaces with a bold coral-red accent.",
    kind: "warm",
    bg: "#fbfbf9",
    surface: "#ffffff",
    surface2: "#f6f6f3",
    surface3: "#faf9f6",
    surface4: "#e5e5e0",
    surfaceWarm: "#f0eee9",
    ink: "#211922",
    onInk: "#ffffff",
    brand: "#e60023",
    brandLight: "#f6c0c8",
    brandWarm: "#7e238b",
    brandWarmStrong: "#cc001f",
    swatch: ["#fbfbf9", "#f6f6f3", "#e60023", "#211922"],
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm cream IDE canvas, near-black ink, ember-orange accent.",
    kind: "warm",
    bg: "#f7f7f4",
    surface: "#ffffff",
    surface2: "#fafaf7",
    surface3: "#fbfbf9",
    surface4: "#efeee8",
    surfaceWarm: "#f0eee8",
    ink: "#26251e",
    onInk: "#ffffff",
    brand: "#f54e00",
    brandLight: "#dfa88f",
    brandWarm: "#c08532",
    brandWarmStrong: "#cf2d56",
    swatch: ["#f7f7f4", "#efeee8", "#f54e00", "#26251e"],
  },
  {
    id: "vinyl",
    label: "Vinyl",
    description: "Near-black surfaces, bright music-green accent.",
    kind: "dark",
    bg: "#121212",
    surface: "#181818",
    surface2: "#1f1f1f",
    surface3: "#252525",
    surface4: "#0a0a0a",
    surfaceWarm: "#272727",
    ink: "#ffffff",
    onInk: "#121212",
    brand: "#1ed760",
    brandLight: "#1db954",
    brandWarm: "#539df5",
    brandWarmStrong: "#f3727f",
    swatch: ["#121212", "#181818", "#1ed760", "#ffffff"],
  },
  {
    id: "scarlet",
    label: "Scarlet",
    description: "Charcoal canvas, racing scarlet accent.",
    kind: "dark",
    bg: "#181818",
    surface: "#262626",
    surface2: "#303030",
    surface3: "#212121",
    surface4: "#0e0e0e",
    surfaceWarm: "#2a2a2a",
    ink: "#ffffff",
    onInk: "#181818",
    brand: "#da291c",
    brandLight: "#fff200",
    brandWarm: "#f13a2c",
    brandWarmStrong: "#b01e0a",
    swatch: ["#181818", "#303030", "#da291c", "#ffffff"],
  },
  {
    id: "glacier",
    label: "Glacier",
    description: "Indigo-tinted near-black, cool lavender-blue accent.",
    kind: "dark",
    bg: "#010102",
    surface: "#0f1011",
    surface2: "#141516",
    surface3: "#191a1b",
    surface4: "#23252a",
    surfaceWarm: "#18191a",
    ink: "#f7f8f8",
    onInk: "#010102",
    brand: "#5e6ad2",
    brandLight: "#828fff",
    brandWarm: "#7a7fad",
    brandWarmStrong: "#5e69d1",
    swatch: ["#010102", "#141516", "#5e6ad2", "#f7f8f8"],
  },
  {
    id: "phosphor",
    label: "Phosphor",
    description: "Pure black canvas, neon phosphor-green accent.",
    kind: "dark",
    bg: "#000000",
    surface: "#1a1a1a",
    surface2: "#1a1a1a",
    surface3: "#0d0d0d",
    surface4: "#0a0a0a",
    surfaceWarm: "#171717",
    ink: "#ffffff",
    onInk: "#000000",
    brand: "#76b900",
    brandLight: "#bff230",
    brandWarm: "#952fc6",
    brandWarmStrong: "#0046a4",
    swatch: ["#000000", "#1a1a1a", "#76b900", "#ffffff"],
  },
  {
    id: "hornet",
    label: "Hornet",
    description: "Absolute black canvas, hornet-yellow accent.",
    kind: "dark",
    bg: "#000000",
    surface: "#181818",
    surface2: "#202020",
    surface3: "#181818",
    surface4: "#0a0a0a",
    surfaceWarm: "#202020",
    ink: "#ffffff",
    onInk: "#000000",
    brand: "#ffc000",
    brandLight: "#ffce3e",
    brandWarm: "#29abe2",
    brandWarmStrong: "#917300",
    swatch: ["#000000", "#202020", "#ffc000", "#ffffff"],
  },
  {
    id: "prism",
    label: "Prism",
    description: "Near-black canvas with a vivid magenta-prism accent.",
    kind: "dark",
    bg: "#090909",
    surface: "#141414",
    surface2: "#1a1a1a",
    surface3: "#1c1c1c",
    surface4: "#262626",
    surfaceWarm: "#1a1a1a",
    ink: "#ffffff",
    onInk: "#090909",
    brand: "#d44df0",
    brandLight: "#ff5577",
    brandWarm: "#6a4cf5",
    brandWarmStrong: "#ff7a3d",
    swatch: ["#090909", "#141414", "#d44df0", "#ffffff"],
  },
];

/* ─── CSS emitter ─────────────────────────────────────────── */

function inkAlphas(p) {
  if (p.kind === "dark") return INK_ALPHAS_DARK;
  if (p.kind === "warm") return INK_ALPHAS_WARM;
  return INK_ALPHAS_LIGHT;
}

function genTheme(p) {
  const inkScale = inkAlphas(p);
  const lines = [];

  lines.push(`/* ─── ${p.label} — ${p.description} */`);
  lines.push(`:root[data-theme="${p.id}"] {`);

  // Surfaces
  lines.push(`  --app-bg: ${p.bg};`);
  lines.push(`  --surface: ${p.surface};`);
  lines.push(`  --surface-2: ${p.surface2};`);
  lines.push(`  --surface-3: ${p.surface3};`);
  lines.push(`  --surface-4: ${p.surface4};`);
  lines.push(`  --surface-warm: ${p.surfaceWarm};`);
  lines.push("");

  // Ink base + alpha scale
  lines.push(`  --ink: ${p.ink};`);
  for (const [k, a] of Object.entries(inkScale)) {
    lines.push(`  --ink-${k}: ${rgba(p.ink, a)};`);
  }
  lines.push("");

  // Solid dark variants — shift with theme kind
  if (p.kind === "dark") {
    lines.push(`  --ink-strong: #0a0805;`);
    lines.push(`  --ink-strong-hover: #000000;`);
    lines.push(`  --ink-deep: #050402;`);
  } else {
    lines.push(`  --ink-strong: ${p.ink};`);
    lines.push(`  --ink-strong-hover: #000000;`);
    lines.push(`  --ink-deep: ${p.ink};`);
  }
  lines.push("");

  // On-ink (overlays drawn on dark/brand surfaces)
  lines.push(`  --on-ink: ${p.onInk};`);
  lines.push(`  --on-brand: #ffffff;`);
  for (const [k, a] of Object.entries(ON_INK_ALPHAS)) {
    lines.push(`  --on-ink-${k}: ${rgba(p.onInk, a)};`);
  }
  // soft cream variants — for light text on dark surfaces
  const soft = p.kind === "dark" ? p.ink : "#f5f2eb";
  lines.push(`  --on-ink-soft-65: ${rgba(soft, 0.70)};`);
  lines.push(`  --on-ink-soft-80: ${rgba(soft, 0.86)};`);
  lines.push(`  --on-ink-soft-90: ${rgba(soft, 0.94)};`);
  lines.push("");

  // Placeholders
  lines.push(`  --placeholder: ${rgba(p.ink, 0.40)};`);
  lines.push(`  --placeholder-strong: ${rgba(p.ink, 0.55)};`);
  lines.push("");

  // Brand
  lines.push(`  --brand: ${p.brand};`);
  lines.push(`  --brand-fg: ${p.brand};`);
  lines.push(`  --brand-strong-fg: ${p.brand};`);
  lines.push(`  --brand-faint: ${rgba(p.brand, 0.05)};`);
  lines.push(`  --brand-soft: ${rgba(p.brand, 0.08)};`);
  lines.push(`  --brand-bg: ${rgba(p.brand, 0.12)};`);
  lines.push(`  --brand-border: ${rgba(p.brand, 0.22)};`);
  lines.push(`  --brand-hover: ${rgba(p.brand, 0.18)};`);
  lines.push(`  --brand-strong: ${rgba(p.brand, 0.50)};`);
  lines.push(`  --brand-light: ${p.brandLight};`);
  lines.push(`  --brand-warm: ${p.brandWarm};`);
  lines.push(`  --brand-warm-strong: ${p.brandWarmStrong};`);
  lines.push("");

  // Semantic — keep universal hue but tweak alpha for visibility on dark
  if (p.kind === "dark") {
    lines.push(`  --danger: #ff6b6b;`);
    lines.push(`  --danger-fg: #ff9b9b;`);
    lines.push(`  --danger-bg: rgba(255, 107, 107, 0.16);`);
    lines.push(`  --danger-bg-strong: rgba(255, 107, 107, 0.10);`);
    lines.push(`  --danger-border: rgba(255, 107, 107, 0.32);`);
    lines.push("");
    lines.push(`  --success: #4ade80;`);
    lines.push(`  --success-fg: #86efac;`);
    lines.push(`  --success-alt: #4ade80;`);
    lines.push(`  --success-alt-bg: rgba(74, 222, 128, 0.16);`);
    lines.push(`  --success-alt-border: rgba(74, 222, 128, 0.34);`);
    lines.push("");
    lines.push(`  --info: #6ea8fe;`);
    lines.push(`  --info-strong: rgba(110, 168, 254, 1);`);
    lines.push(`  --info-alt: #6ea8fe;`);
    lines.push(`  --info-alt-bg: rgba(110, 168, 254, 0.16);`);
    lines.push(`  --info-alt-border: rgba(110, 168, 254, 0.34);`);
    lines.push(`  --info-alt-soft: rgba(110, 168, 254, 0.10);`);
    lines.push("");
    lines.push(`  --warning: #fbbf24;`);
    lines.push(`  --warning-fg: #fcd34d;`);
    lines.push(`  --warning-bg: rgba(251, 191, 36, 0.16);`);
    lines.push(`  --warning-border: rgba(251, 191, 36, 0.34);`);
  } else {
    lines.push(`  --danger: #c53030;`);
    lines.push(`  --danger-fg: #7a2222;`);
    lines.push(`  --danger-bg: rgba(197, 48, 48, 0.10);`);
    lines.push(`  --danger-bg-strong: rgba(211, 47, 47, 0.08);`);
    lines.push(`  --danger-border: rgba(211, 47, 47, 0.25);`);
    lines.push("");
    lines.push(`  --success: #34c759;`);
    lines.push(`  --success-fg: #1a4d2e;`);
    lines.push(`  --success-alt: #2ea043;`);
    lines.push(`  --success-alt-bg: rgba(46, 160, 67, 0.12);`);
    lines.push(`  --success-alt-border: rgba(46, 160, 67, 0.28);`);
    lines.push("");
    lines.push(`  --info: #2563eb;`);
    lines.push(`  --info-strong: rgba(20, 60, 160, 1);`);
    lines.push(`  --info-alt: #3677e2;`);
    lines.push(`  --info-alt-bg: rgba(54, 119, 226, 0.12);`);
    lines.push(`  --info-alt-border: rgba(54, 119, 226, 0.28);`);
    lines.push(`  --info-alt-soft: rgba(54, 119, 226, 0.06);`);
    lines.push("");
    lines.push(`  --warning: #d97706;`);
    lines.push(`  --warning-fg: #92400e;`);
    lines.push(`  --warning-bg: rgba(217, 119, 6, 0.12);`);
    lines.push(`  --warning-border: rgba(217, 119, 6, 0.25);`);
  }
  lines.push("");

  // Brand-warm tints
  lines.push(`  --brand-warm-soft: ${rgba(p.brandWarm, 0.10)};`);
  lines.push(`  --brand-warm-bg: ${rgba(p.brandWarm, 0.14)};`);
  lines.push(`  --brand-stronger: ${rgba(p.brand, 0.85)};`);
  lines.push("");

  // Icon backgrounds — desaturate against the surface
  if (p.kind === "dark") {
    lines.push(`  --icon-bg-warm: rgba(255, 200, 170, 0.18);`);
    lines.push(`  --icon-bg-cool: rgba(180, 200, 240, 0.18);`);
    lines.push(`  --icon-bg-blue-soft: rgba(110, 168, 254, 0.22);`);
    lines.push(`  --icon-bg-blue-strong: rgba(110, 168, 254, 0.78);`);
    lines.push(`  --icon-bg-light: ${rgba(p.ink, 0.10)};`);
  } else {
    lines.push(`  --icon-bg-warm: rgba(255, 215, 195, 0.7);`);
    lines.push(`  --icon-bg-cool: rgba(210, 215, 240, 0.7);`);
    lines.push(`  --icon-bg-blue-soft: rgba(80, 100, 200, 0.18);`);
    lines.push(`  --icon-bg-blue-strong: rgba(60, 80, 180, 0.78);`);
    lines.push(`  --icon-bg-light: rgba(255, 255, 255, 0.6);`);
  }
  lines.push("");

  // Backdrop + shadows
  if (p.kind === "dark") {
    lines.push(`  --backdrop: rgba(0, 0, 0, 0.65);`);
    lines.push(`  --backdrop-strong: rgba(0, 0, 0, 0.82);`);
    lines.push(`  --shadow-card: 0 1px 2px 0 rgba(0, 0, 0, 0.40);`);
    lines.push(`  --shadow-pop:  0 8px 24px rgba(0, 0, 0, 0.50), 0 1px 2px rgba(0, 0, 0, 0.40);`);
    lines.push(`  --shadow-deep: 0 24px 64px rgba(0, 0, 0, 0.70);`);
    lines.push(`  --shadow-sm:   0 1px 2px rgba(0, 0, 0, 0.40);`);
    lines.push(`  --shadow-md:   0 8px 24px rgba(0, 0, 0, 0.55);`);
  } else {
    lines.push(`  --backdrop: ${rgba(p.ink, 0.45)};`);
    lines.push(`  --backdrop-strong: ${rgba(p.ink, 0.82)};`);
    lines.push(`  --shadow-card: 0 1px 2px 0 ${rgba(p.ink, 0.06)};`);
    lines.push(`  --shadow-pop:  0 8px 24px ${rgba(p.ink, 0.12)}, 0 1px 2px ${rgba(p.ink, 0.06)};`);
    lines.push(`  --shadow-deep: 0 24px 64px ${rgba(p.ink, 0.40)};`);
    lines.push(`  --shadow-sm:   0 1px 2px ${rgba(p.ink, 0.06)};`);
    lines.push(`  --shadow-md:   0 8px 24px ${rgba(p.ink, 0.14)};`);
  }

  lines.push(`}`);
  return lines.join("\n");
}

/* ─── Main ────────────────────────────────────────────────── */

const banner = `/* AUTOGENERATED — do not edit. Regenerate via: node tools/gen-themes.mjs
 *
 * Each :root[data-theme="<id>"] block below remaps the design tokens
 * defined in web/src/index.css to a different palette. The TS-side
 * companion is THEMES in web/src/lib/theme.ts (id, label, swatch).
 *
 * Adding a theme: push a new entry to PALETTES in tools/gen-themes.mjs,
 * mirror it in THEMES in web/src/lib/theme.ts, and re-run this script. */`;

const blocks = PALETTES.map(genTheme).join("\n\n");
const out = `${banner}\n\n${blocks}\n`;

writeFileSync(OUT_PATH, out);
console.log(`Wrote ${PALETTES.length} themes to ${OUT_PATH}`);
