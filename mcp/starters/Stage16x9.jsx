/* Stage16x9 — fixed 1920×1080 stage that auto-scales to any viewport.
 *
 * Use as the root frame for YouTube-format designs (thumbnails, opening
 * titles, end cards). Children render at full 1920×1080 resolution; the
 * stage CSS-scales them to fit the iframe with letterbox bars.
 *
 * Usage in index.html:
 *   <script type="text/babel" src="Stage16x9.jsx"></script>
 *   <script type="text/babel">
 *     ReactDOM.createRoot(document.getElementById("root")).render(
 *       <Stage16x9>
 *         <h1 style={{ position: "absolute", top: 60, left: 60 }}>Hello</h1>
 *       </Stage16x9>
 *     );
 *   </script>
 */

const Stage16x9 = ({ children, background = "#fff", showSafeArea = false }) => {
  const wrapRef = React.useRef(null);
  const [scale, setScale] = React.useState(1);

  React.useEffect(() => {
    const fit = () => {
      const el = wrapRef.current;
      if (!el) return;
      setScale(Math.min(el.clientWidth / 1920, el.clientHeight / 1080));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${scale})`,
          transformOrigin: "center",
          background,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {children}
        {showSafeArea && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: "5%",
              border: "2px dashed rgba(255, 100, 100, 0.5)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    </div>
  );
};

window.Stage16x9 = Stage16x9;
