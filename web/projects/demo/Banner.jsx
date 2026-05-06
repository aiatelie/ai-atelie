/* Banner.jsx — three LinkedIn-banner directions for AI Atelie.
 *
 * All variants render at native 1584×396 (LinkedIn personal-profile size)
 * so /api/export-element produces the exact pixel asset LinkedIn expects.
 *
 * Brief: confident, restrained, technical — Linear / Stripe / Vercel
 * register. Strong sans-serif, tight letter-spacing on the headline,
 * mono caption for labels.
 *
 *   A — "Editorial" : paper background, ink headline, burnt accent on the
 *                     URL highlight. The default — feels like a journal.
 *   B — "Nocturne"  : ink background, paper headline, soft blue accent
 *                     glow. The feed-stopper.
 *   C — "Clinical"  : white background, ink headline, blue accent only.
 *                     Maximum sparseness — reads at any size.
 *
 * Composition (shared, 4:1 = 1584×396):
 *   Left  ~45% : headline + sub-headline
 *   Center ~25%: small abstract visual (architecture diagram OR atelier mark)
 *   Right ~30% : github.com/aiatelie/ai-atelie  +  OPEN SOURCE · MIT stamp
 */

const FONT_SANS = '"Inter", "InterVariable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace';

const PALETTE = {
  ink:        "#0E1116",
  paper:      "#FBF7EE",
  white:      "#FFFFFF",
  blue:       "#2657FF",
  burnt:      "#D97757",
  inkSoft:    "#5A6470",
  inkSofter:  "#8A929B",
  rule:       "#E8E0CD",
  ruleClean:  "#EEEEEE",   // for clinical variant on white
  paperSoft:  "rgba(251,247,238,0.62)",
  paperFaint: "rgba(251,247,238,0.32)",
};

/* ------------------------------------------------------------------ *
 * Tweakable defaults — host's tweak panel rewrites this block in place
 * when knobs move.  Keep the JSON shape simple and stable.
 * ------------------------------------------------------------------ */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "headline":  "An atelier for the agent era",
  "subhead":   "Local-first, MIT-licensed — driven by the CLI you already have on your PATH.",
  "accent":    "blue",
  "visual":    "diagram"
}/*EDITMODE-END*/;

/* Resolve the active accent hex from the named choice. */
function resolveAccent(choice) {
  if (choice === "burnt") return PALETTE.burnt;
  return PALETTE.blue;
}

/* ============================================================== *
 * Center visual — toggleable between an architecture diagram
 * (web → api → agent CLI) and a minimal atelier mark.  The diagram
 * communicates the BYO-CLI thesis at a glance; the mark is quieter
 * and lets the type breathe.  Both render in --currentColor so each
 * variant can re-tint the strokes without forking the SVG.
 * ============================================================== */
function ArchDiagram({ accent, muted, strong }) {
  /* three nodes connected by hairline arrows.  the agent node is
   * accent-bordered to make "you control the model" the focal point. */
  const nodeW = 110;
  const nodeH = 48;
  const gap   = 26;
  const totalW = nodeW * 3 + gap * 2;

  const Node = ({ x, label, sublabel, isAccent }) => (
    <g transform={`translate(${x},0)`}>
      <rect
        x={0}
        y={0}
        width={nodeW}
        height={nodeH}
        rx={6}
        fill="none"
        stroke={isAccent ? accent : strong}
        strokeWidth={isAccent ? 1.6 : 1.1}
      />
      <text
        x={nodeW / 2}
        y={20}
        textAnchor="middle"
        fontFamily={FONT_MONO}
        fontSize="11"
        fontWeight="600"
        letterSpacing="1.2"
        fill={isAccent ? accent : strong}
      >
        {label}
      </text>
      <text
        x={nodeW / 2}
        y={36}
        textAnchor="middle"
        fontFamily={FONT_MONO}
        fontSize="9"
        letterSpacing="1.6"
        fill={muted}
      >
        {sublabel}
      </text>
    </g>
  );

  const Connector = ({ x }) => (
    <g transform={`translate(${x},${nodeH / 2})`} stroke={muted} fill="none" strokeWidth="1.1">
      <line x1={0} y1={0} x2={gap - 6} y2={0} />
      <path d={`M${gap - 10},-3 L${gap - 6},0 L${gap - 10},3`} />
    </g>
  );

  return (
    <svg width={totalW} height={nodeH + 24} viewBox={`0 0 ${totalW} ${nodeH + 24}`}>
      {/* tiny mono caption above */}
      <text
        x={0}
        y={nodeH + 18}
        fontFamily={FONT_MONO}
        fontSize="9"
        letterSpacing="2.4"
        fill={muted}
      >
        EDITOR · API · AGENT — YOUR CLI, YOUR MODEL
      </text>
      <Node x={0}                  label="WEB"   sublabel="canvas" />
      <Connector x={nodeW} />
      <Node x={nodeW + gap}        label="API"   sublabel="export" />
      <Connector x={(nodeW + gap) * 2 - gap} />
      <Node x={(nodeW + gap) * 2}  label="AGENT" sublabel="byo-cli" isAccent />
    </svg>
  );
}

/* Atelier mark — three offset frames suggesting layered design surfaces.
 * The accent frame is solid; the other two are hairlines.  Sits inside
 * a square ~120×120 so it can swap places with ArchDiagram cleanly. */
function AtelierMark({ accent, muted, strong }) {
  const size = 132;
  const f = 64;   // frame size
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* back frame */}
      <rect x={size - f - 4} y={4} width={f} height={f} rx={3}
            fill="none" stroke={muted} strokeWidth="1.1" />
      {/* middle frame */}
      <rect x={(size - f) / 2} y={(size - f) / 2} width={f} height={f} rx={3}
            fill="none" stroke={strong} strokeWidth="1.3" />
      {/* front accent frame */}
      <rect x={4} y={size - f - 4} width={f} height={f} rx={3}
            fill={accent} stroke={accent} strokeWidth="1" />
      {/* hairline crosshair through accent frame, paper-colored,
          to keep it from reading as a flat block */}
      <line x1={4 + f / 2} y1={size - f - 4 + 12}
            x2={4 + f / 2} y2={size - f - 4 + f - 12}
            stroke="#FBF7EE" strokeOpacity="0.55" strokeWidth="1" />
      <line x1={4 + 12} y1={size - f - 4 + f / 2}
            x2={4 + f - 12} y2={size - f - 4 + f / 2}
            stroke="#FBF7EE" strokeOpacity="0.55" strokeWidth="1" />
    </svg>
  );
}

function CenterVisual({ visual, accent, muted, strong }) {
  if (visual === "mark") return <AtelierMark accent={accent} muted={muted} strong={strong} />;
  return <ArchDiagram accent={accent} muted={muted} strong={strong} />;
}

/* ============================================================== *
 * Shared right-column block — github URL + OPEN SOURCE · MIT stamp.
 * The accent color highlights only the `ai-atelie` repo segment so
 * the URL still reads as a path, not a pile of color.
 * ============================================================== */
function RightRail({ accent, fg, muted, fgUrl }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 18,
        textAlign: "right",
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          color: muted,
        }}
      >
        Source
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 22,
          fontWeight: 500,
          letterSpacing: "-0.005em",
          color: fgUrl,
          lineHeight: 1.1,
        }}
      >
        github.com/aiatelie/
        <span style={{ color: accent, fontWeight: 600 }}>ai-atelie</span>
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.36em",
          textTransform: "uppercase",
          color: muted,
        }}
      >
        Open source <span style={{ opacity: 0.5 }}>·</span> MIT
      </div>
    </div>
  );
}

/* ============================================================== *
 * Headline + sub-headline block — left ~45%.  Tracks tightly,
 * pushes weight on the headline, lets the sub breathe.
 * ============================================================== */
function HeadlineBlock({ headline, subhead, fg, fgSub, eyebrowColor }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 720 }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.36em",
          textTransform: "uppercase",
          color: eyebrowColor,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 18,
            height: 1,
            background: eyebrowColor,
            opacity: 0.7,
          }}
        />
        AI Atelie <span style={{ opacity: 0.5 }}>·</span> v1.0
      </div>

      <div
        style={{
          fontFamily: FONT_SANS,
          fontWeight: 700,
          fontSize: 64,
          lineHeight: 1.02,
          letterSpacing: "-0.035em",
          color: fg,
        }}
      >
        {headline}
      </div>

      <div
        style={{
          fontFamily: FONT_SANS,
          fontWeight: 400,
          fontSize: 21,
          lineHeight: 1.4,
          letterSpacing: "-0.005em",
          color: fgSub,
          maxWidth: 620,
        }}
      >
        {subhead}
      </div>
    </div>
  );
}

/* ============================================================== *
 * Variant A — "Editorial"
 * Paper background, ink headline, burnt accent reserved for the
 * `ai-atelie` URL highlight.  The default-feeling direction.
 * Hairline rules along top and bottom give it a journal/spec-sheet
 * register without going twee.
 * ============================================================== */
function BannerEditorial({ headline, subhead, accent, visual }) {
  const accentHex = resolveAccent(accent);
  return (
    <div
      style={{
        position: "relative",
        width: 1584,
        height: 396,
        background: PALETTE.paper,
        color: PALETTE.ink,
        fontFamily: FONT_SANS,
        overflow: "hidden",
      }}
    >
      {/* top hairline */}
      <div style={{ position: "absolute", top: 36, left: 64, right: 64, height: 1, background: PALETTE.rule }} />
      {/* bottom hairline */}
      <div style={{ position: "absolute", bottom: 36, left: 64, right: 64, height: 1, background: PALETTE.rule }} />

      {/* main 3-column layout */}
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 64,
          bottom: 64,
          display: "grid",
          gridTemplateColumns: "1.45fr 0.85fr 1fr",
          alignItems: "center",
          gap: 40,
        }}
      >
        <HeadlineBlock
          headline={headline}
          subhead={subhead}
          fg={PALETTE.ink}
          fgSub={PALETTE.inkSoft}
          eyebrowColor={PALETTE.inkSoft}
        />

        <div style={{ color: PALETTE.ink, display: "flex", justifyContent: "center" }}>
          <CenterVisual
            visual={visual}
            accent={accentHex}
            muted={PALETTE.inkSofter}
            strong={PALETTE.ink}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RightRail
            accent={accentHex}
            fg={PALETTE.ink}
            fgUrl={PALETTE.ink}
            muted={PALETTE.inkSoft}
          />
        </div>
      </div>
    </div>
  );
}

/* ============================================================== *
 * Variant B — "Nocturne"
 * Ink background, paper-cream headline, soft blue accent glow on
 * the URL + a faint radial bloom behind the center visual.  The
 * feed-stopper — high contrast, will pop in a LinkedIn timeline.
 * ============================================================== */
function BannerNocturne({ headline, subhead, accent, visual }) {
  const accentHex = resolveAccent(accent);
  /* derive a glow color from the accent (semi-transparent) so the
   * burnt swap still feels intentional, not bolted on. */
  const glow = accent === "burnt"
    ? "rgba(217,119,87,0.32)"
    : "rgba(38,87,255,0.32)";

  return (
    <div
      style={{
        position: "relative",
        width: 1584,
        height: 396,
        background: `
          radial-gradient(900px 420px at 62% 50%, ${glow}, transparent 60%),
          radial-gradient(600px 360px at 14% 0%, rgba(255,255,255,0.04), transparent 65%),
          ${PALETTE.ink}
        `,
        color: PALETTE.paper,
        fontFamily: FONT_SANS,
        overflow: "hidden",
      }}
    >
      {/* top + bottom hairlines, paper @ low opacity */}
      <div style={{ position: "absolute", top: 36, left: 64, right: 64, height: 1, background: "rgba(251,247,238,0.14)" }} />
      <div style={{ position: "absolute", bottom: 36, left: 64, right: 64, height: 1, background: "rgba(251,247,238,0.14)" }} />

      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 64,
          bottom: 64,
          display: "grid",
          gridTemplateColumns: "1.45fr 0.85fr 1fr",
          alignItems: "center",
          gap: 40,
        }}
      >
        <HeadlineBlock
          headline={headline}
          subhead={subhead}
          fg={PALETTE.paper}
          fgSub="rgba(251,247,238,0.72)"
          eyebrowColor={accentHex}
        />

        <div style={{ display: "flex", justifyContent: "center" }}>
          <CenterVisual
            visual={visual}
            accent={accentHex}
            muted="rgba(251,247,238,0.42)"
            strong="rgba(251,247,238,0.88)"
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RightRail
            accent={accentHex}
            fg={PALETTE.paper}
            fgUrl={PALETTE.paper}
            muted="rgba(251,247,238,0.55)"
          />
        </div>
      </div>
    </div>
  );
}

/* ============================================================== *
 * Variant C — "Clinical"
 * White background, ink headline, accent blue only — no burnt, no
 * texture, no rule hairlines.  Maximum sparseness.  Reads cleanly
 * on LinkedIn's mobile crop where the banner gets squished.
 * ============================================================== */
function BannerClinical({ headline, subhead, accent, visual }) {
  /* Clinical leans hard on the blue accent — burnt swap is allowed
   * but blue is the brief default.  Either way the rest stays mute. */
  const accentHex = resolveAccent(accent);
  return (
    <div
      style={{
        position: "relative",
        width: 1584,
        height: 396,
        background: PALETTE.white,
        color: PALETTE.ink,
        fontFamily: FONT_SANS,
        overflow: "hidden",
      }}
    >
      {/* one single hairline divider sitting between left block and
          everything else — sparser than A's full top+bottom rules */}
      <div
        style={{
          position: "absolute",
          left: "44%",
          top: 88,
          bottom: 88,
          width: 1,
          background: PALETTE.ruleClean,
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          top: 70,
          bottom: 70,
          display: "grid",
          gridTemplateColumns: "1.45fr 0.85fr 1fr",
          alignItems: "center",
          gap: 56,
        }}
      >
        <HeadlineBlock
          headline={headline}
          subhead={subhead}
          fg={PALETTE.ink}
          fgSub={PALETTE.inkSoft}
          eyebrowColor={accentHex}
        />

        <div style={{ display: "flex", justifyContent: "center" }}>
          <CenterVisual
            visual={visual}
            accent={accentHex}
            muted={PALETTE.inkSofter}
            strong={PALETTE.ink}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RightRail
            accent={accentHex}
            fg={PALETTE.ink}
            fgUrl={PALETTE.ink}
            muted={PALETTE.inkSoft}
          />
        </div>
      </div>
    </div>
  );
}

/* ----------------- dispatcher ----------------- */
function Banner({
  variant = "editorial",
  headline = TWEAK_DEFAULTS.headline,
  subhead  = TWEAK_DEFAULTS.subhead,
  accent   = TWEAK_DEFAULTS.accent,
  visual   = TWEAK_DEFAULTS.visual,
}) {
  const props = { headline, subhead, accent, visual };
  if (variant === "nocturne") return <BannerNocturne {...props} />;
  if (variant === "clinical") return <BannerClinical {...props} />;
  return <BannerEditorial {...props} />;
}

window.Banner = Banner;
