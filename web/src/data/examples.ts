/* examples.ts — curated prompt examples for the home page Examples tab.
 *
 * Each entry seeds a brand-new project: clicking "Use this prompt"
 * creates the project, then bounces into /editor?fresh=1&prompt=<text>
 * which fires the prompt as the first user turn (riding the standard
 * intake preamble — same path as if the user had typed it themselves).
 *
 * `previewHtml` renders inside a sandboxed iframe (sandbox="allow-scripts")
 * so the card shows the *kind* of artifact the prompt produces without
 * having to actually run Claude. Keep snippets self-contained — no
 * external fonts/images, inline styles only — so previews paint fast and
 * never depend on network state.
 */

export type Example = {
  /** Stable id, used as a React key + `data-id` on the card for tests. */
  id: string;
  /** Card title — what the user is "making". */
  title: string;
  /** The exact prompt text that gets fired into the new project. Shown in
   *  italic quote style on the card so the user knows what they'll send. */
  prompt: string;
  /** Static HTML rendered inside the iframe preview. Inline styles only;
   *  the iframe document is empty otherwise. */
  previewHtml: string;
};

export const EXAMPLES: Example[] = [
  {
    id: "hero-banner",
    title: "Hero banner",
    prompt: "Design a bold hero banner for a climbing event. High fidelity, photography-led, gritty and raw.",
    previewHtml: `<div style="background:#1a1a1a;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#fff;font-size:2rem;font-weight:800;letter-spacing:-0.02em">CLIMB HARDER</div>`,
  },
  {
    id: "landing-page",
    title: "Landing page",
    prompt: "Design a landing page for a coffee subscription startup. Specialty, third-wave, warm and artisanal.",
    previewHtml: `<div style="background:#f5f0e8;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:serif;gap:8px"><div style="font-size:2rem;font-weight:700;color:#2c1810">Morning Ritual</div><div style="color:#7a5c4a;font-size:0.9rem">Specialty coffee, delivered.</div></div>`,
  },
  {
    id: "slide-deck",
    title: "OKR slide deck",
    prompt: "Make a slide deck about quarterly OKRs for an engineering all-hands. Clean, minimal, data-forward.",
    previewHtml: `<div style="background:#fff;width:100%;height:100%;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:2rem;font-family:sans-serif;box-sizing:border-box"><div style="font-size:0.7rem;font-weight:600;color:#888;letter-spacing:0.1em;margin-bottom:0.5rem">Q1 2026 &middot; ENG ALL-HANDS</div><div style="font-size:1.8rem;font-weight:700;color:#111;line-height:1.2">Quarterly<br/>OKRs</div></div>`,
  },
  {
    id: "interactive-prototype",
    title: "Interactive prototype",
    prompt: "Prototype an onboarding flow for a food delivery app. Fully interactive with realistic transitions and form validation.",
    previewHtml: `<div style="background:linear-gradient(135deg,#ff6b35,#f7931e);width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;color:#fff;gap:12px"><div style="font-size:2rem">&#127828;</div><div style="font-size:1.2rem;font-weight:700">QuickBite</div><div style="font-size:0.8rem;opacity:0.8">Get started in 30 seconds</div></div>`,
  },
];
