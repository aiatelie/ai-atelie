/* LowerThird — broadcast-style title strip with tweakable defaults.
 *
 * Drop into any Stage (Stage16x9 / Stage9x16). Edit the TWEAK_DEFAULTS
 * block to retune live; the values are also exposed as props so you can
 * feed them from a knob panel or theme.
 *
 * Usage:
 *   <Stage16x9>
 *     <LowerThird title="Jane Doe" subtitle="Speaker · Title" />
 *   </Stage16x9>
 */

// Wrapped in EDITMODE markers so the host's tweak panel can hot-rewrite
// these values when the user moves a slider — see the make-tweakable skill.
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#d97757",
  "textColor": "#ffffff",
  "barHeight": 140,
  "fontFamily": "ui-sans-serif, system-ui, sans-serif",
  "titleSize": 56,
  "subtitleSize": 28,
  "anchorBottom": 80,
  "anchorLeft": 80,
  "barWidthPct": 60,
  "tilt": 0
}/*EDITMODE-END*/;

const LowerThird = ({
  title = "Title",
  subtitle = "Subtitle line",
  primaryColor = TWEAK_DEFAULTS.primaryColor,
  textColor = TWEAK_DEFAULTS.textColor,
  barHeight = TWEAK_DEFAULTS.barHeight,
  fontFamily = TWEAK_DEFAULTS.fontFamily,
  titleSize = TWEAK_DEFAULTS.titleSize,
  subtitleSize = TWEAK_DEFAULTS.subtitleSize,
  anchorBottom = TWEAK_DEFAULTS.anchorBottom,
  anchorLeft = TWEAK_DEFAULTS.anchorLeft,
  barWidthPct = TWEAK_DEFAULTS.barWidthPct,
  tilt = TWEAK_DEFAULTS.tilt,
}) => {
  return (
    <div
      style={{
        position: "absolute",
        bottom: anchorBottom,
        left: anchorLeft,
        width: `${barWidthPct}%`,
        height: barHeight,
        background: primaryColor,
        color: textColor,
        fontFamily,
        padding: `${barHeight * 0.15}px ${barHeight * 0.25}px`,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
        transform: `skewX(${-tilt}deg)`,
      }}
    >
      <div
        style={{
          transform: `skewX(${tilt}deg)`,
          fontSize: titleSize,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: -0.5,
        }}
      >
        {title}
      </div>
      <div
        style={{
          transform: `skewX(${tilt}deg)`,
          fontSize: subtitleSize,
          opacity: 0.85,
          letterSpacing: 0.3,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
};

window.LowerThird = LowerThird;
