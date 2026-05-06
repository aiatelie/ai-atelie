/* Stage9x16 — fixed 1080×1920 vertical stage for Shorts/Reels/TikTok.
 *
 * Auto-scales to any viewport with letterbox bars. Children render at
 * full 1080×1920 design resolution.
 *
 * Usage in index.html:
 *   <script type="text/babel" src="Stage9x16.jsx"></script>
 *   <script type="text/babel">
 *     ReactDOM.createRoot(document.getElementById("root")).render(
 *       <Stage9x16>
 *         <h1 style={{ position: "absolute", top: 200, left: 60 }}>Hello</h1>
 *       </Stage9x16>
 *     );
 *   </script>
 */

const Stage9x16 = ({ children, background = "#fff", showSafeArea = false }) => {
  const wrapRef = React.useRef(null);
  const [scale, setScale] = React.useState(1);

  React.useEffect(() => {
    const fit = () => {
      const el = wrapRef.current;
      if (!el) return;
      setScale(Math.min(el.clientWidth / 1080, el.clientHeight / 1920));
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
          width: 1080,
          height: 1920,
          transform: `scale(${scale})`,
          transformOrigin: "center",
          background,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {children}
        {showSafeArea && (
          <>
            {/* Top safe area: TikTok/Shorts UI */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: 0, left: 0, right: 0, height: 250,
                background: "rgba(255, 100, 100, 0.08)",
                borderBottom: "1px dashed rgba(255, 100, 100, 0.5)",
                pointerEvents: "none",
              }}
            />
            {/* Bottom safe area: caption + CTA */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                bottom: 0, left: 0, right: 0, height: 400,
                background: "rgba(255, 100, 100, 0.08)",
                borderTop: "1px dashed rgba(255, 100, 100, 0.5)",
                pointerEvents: "none",
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

window.Stage9x16 = Stage9x16;
