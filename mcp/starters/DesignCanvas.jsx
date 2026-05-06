/* design-canvas.jsx — Figma-lite design canvas.
 * Ported from DesignCanvas.tsx for CDN-React + Babel-Standalone runtime.
 *
 *   - DCViewport — transform-based pan/zoom; tf state in a ref, written
 *     straight to DOM via translate3d for 60fps panning.
 *   - DesignCanvas — context provider; persists per-section state to
 *     localStorage.
 *   - DCSection / DCArtboard / DCArtboardFrame — flex row of artboards
 *     with grip-drag reorder.
 *   - DCFocusOverlay — portal'd full-screen view with arrow-key nav.
 *   - DCEditable — contentEditable with commit-on-blur/Enter.
 *   - DCPostIt — absolute-positioned sticky note primitive.
 */

const {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} = React;
const { createPortal } = ReactDOM;

const DC = {
  bg: "#f0eee9",
  grid: "rgba(0,0,0,0.06)",
  label: "rgba(60,50,40,0.7)",
  title: "rgba(40,30,20,0.85)",
  subtitle: "rgba(60,50,40,0.6)",
  postitBg: "#fef4a8",
  postitText: "#5a4a2a",
  font:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const DC_STYLE = `
  .dc-editable{cursor:text;outline:none;white-space:nowrap;border-radius:3px;padding:0 2px;margin:0 -2px}
  .dc-editable:focus{background:#fff;box-shadow:0 0 0 1.5px #c96442}
  [data-dc-slot]{transition:transform .18s cubic-bezier(.2,.7,.3,1)}
  [data-dc-slot].dc-dragging{transition:none;z-index:10;pointer-events:none}
  [data-dc-slot].dc-dragging .dc-card{box-shadow:0 12px 40px rgba(0,0,0,.25),0 0 0 2px #c96442;transform:scale(1.02)}
  .dc-card{transition:box-shadow .15s,transform .15s}
  .dc-card *{scrollbar-width:none}
  .dc-card *::-webkit-scrollbar{display:none}
  .dc-labelrow{display:flex;align-items:center;gap:4px;height:24px}
  .dc-grip{cursor:grab;display:flex;align-items:center;padding:5px 4px;border-radius:4px;transition:background .12s}
  .dc-grip:hover{background:rgba(0,0,0,.08)}
  .dc-grip:active{cursor:grabbing}
  .dc-labeltext{cursor:pointer;border-radius:4px;padding:3px 6px;display:flex;align-items:center;transition:background .12s}
  .dc-labeltext:hover{background:rgba(0,0,0,.05)}
  .dc-expand{position:absolute;bottom:100%;right:0;margin-bottom:5px;z-index:2;opacity:0;transition:opacity .12s,background .12s;
    width:22px;height:22px;border-radius:5px;border:none;cursor:pointer;padding:0;
    background:transparent;color:rgba(60,50,40,.7);display:flex;align-items:center;justify-content:center}
  .dc-expand:hover{background:rgba(0,0,0,.06);color:#2a251f}
  [data-dc-slot]:hover .dc-expand{opacity:1}
`;

function ensureDcStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("dc-styles")) return;
  const tag = document.createElement("style");
  tag.id = "dc-styles";
  tag.textContent = DC_STYLE;
  document.head.appendChild(tag);
}

/* Persistence */

const STORAGE_KEY = "design-canvas.state";

function readSaved() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && parsed.sections) || null;
  } catch {
    return null;
  }
}

function writeSaved(sections) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sections }));
  } catch { /* ignore */ }
}

/* Context */

const DCCtx = createContext(null);

/* DesignCanvas */

function DesignCanvas({ children, minScale, maxScale, style }) {
  useEffect(() => { ensureDcStyles(); }, []);

  // Announce ourselves to the host editor (if any) so it knows this
  // page is a workshop that owns its own viewport.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.parent || window.parent === window) return;
    try { window.parent.postMessage({ type: "__page_is_canvas" }, "*"); }
    catch { /* ignore */ }
  }, []);

  const [state, setState] = useState({ sections: {}, focus: null });
  const [ready, setReady] = useState(false);
  const skipNextWrite = useRef(false);

  useEffect(() => {
    const saved = readSaved();
    if (saved) {
      skipNextWrite.current = true;
      setState((s) => ({ ...s, sections: saved }));
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (skipNextWrite.current) { skipNextWrite.current = false; return; }
    const t = window.setTimeout(() => writeSaved(state.sections), 250);
    return () => window.clearTimeout(t);
  }, [state.sections]);

  const registry = {};
  const sectionMeta = {};
  const sectionOrder = [];

  Children.forEach(children, (sec) => {
    if (!isValidElement(sec) || sec.type !== DCSection) return;
    const props = sec.props;
    const sid = props.id != null ? props.id : props.title;
    if (!sid) return;
    sectionOrder.push(sid);
    const persisted = state.sections[sid] || {};
    const srcIds = [];
    Children.forEach(props.children, (ab) => {
      if (!isValidElement(ab) || ab.type !== DCArtboard) return;
      const abProps = ab.props;
      const aid = abProps.id != null ? abProps.id : abProps.label;
      if (!aid) return;
      registry[`${sid}/${aid}`] = { sectionId: sid, artboard: ab };
      srcIds.push(aid);
    });
    const kept = (persisted.order || []).filter((k) => srcIds.includes(k));
    sectionMeta[sid] = {
      title: persisted.title != null ? persisted.title : props.title,
      subtitle: props.subtitle,
      slotIds: [...kept, ...srcIds.filter((k) => !kept.includes(k))],
    };
  });

  const api = useMemo(() => ({
    state,
    section: (id) => state.sections[id] || {},
    patchSection: (id, p) =>
      setState((s) => ({
        ...s,
        sections: {
          ...s.sections,
          [id]: {
            ...s.sections[id],
            ...(typeof p === "function" ? p(s.sections[id] || {}) : p),
          },
        },
      })),
    setFocus: (slotId) => setState((s) => ({ ...s, focus: slotId })),
  }), [state]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") api.setFocus(null);
    };
    const onPd = (e) => {
      const ae = document.activeElement;
      if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPd, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPd, true);
    };
  }, [api]);

  return (
    <DCCtx.Provider value={api}>
      <DCViewport minScale={minScale} maxScale={maxScale} style={style}>
        {ready && children}
      </DCViewport>
      {state.focus && registry[state.focus] && (
        <DCFocusOverlay
          entry={registry[state.focus]}
          sectionMeta={sectionMeta}
          sectionOrder={sectionOrder}
        />
      )}
    </DCCtx.Provider>
  );
}

/* DCViewport */

function DCViewport({ children, minScale = 0.05, maxScale = 8, style = {} }) {
  const vpRef = useRef(null);
  const worldRef = useRef(null);
  const tf = useRef({ x: 0, y: 0, scale: 1 });

  const apply = useCallback(() => {
    const { x, y, scale } = tf.current;
    const el = worldRef.current;
    if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    const vp = vpRef.current;
    if (vp) {
      const tile = 120 * scale;
      vp.style.backgroundSize = `${tile}px ${tile}px`;
      vp.style.backgroundPosition = `${x}px ${y}px`;
    }
  }, []);

  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;

    const zoomAt = (cx, cy, factor) => {
      const r = vp.getBoundingClientRect();
      const px = cx - r.left;
      const py = cy - r.top;
      const t = tf.current;
      const next = Math.min(maxScale, Math.max(minScale, t.scale * factor));
      const k = next / t.scale;
      t.x = px - (px - t.x) * k;
      t.y = py - (py - t.y) * k;
      t.scale = next;
      apply();
    };

    const isMouseWheel = (e) =>
      e.deltaMode !== 0 ||
      (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);

    let isGesturing = false;

    const onWheel = (e) => {
      e.preventDefault();
      if (isGesturing) return;
      if (e.ctrlKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else if (isMouseWheel(e)) {
        zoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(e.deltaY) * 0.18));
      } else {
        tf.current.x -= e.deltaX;
        tf.current.y -= e.deltaY;
        apply();
      }
    };

    let gsBase = 1;
    const onGestureStart = (e) => {
      e.preventDefault();
      isGesturing = true;
      gsBase = tf.current.scale;
    };
    const onGestureChange = (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, (gsBase * e.scale) / tf.current.scale);
    };
    const onGestureEnd = (e) => {
      e.preventDefault();
      isGesturing = false;
    };

    let drag = null;
    const onPointerDown = (e) => {
      const target = e.target;
      const onBg = !target.closest("[data-dc-slot], .dc-editable");
      if (!(e.button === 1 || (e.button === 0 && onBg))) return;
      e.preventDefault();
      vp.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, lx: e.clientX, ly: e.clientY };
      vp.style.cursor = "grabbing";
    };
    const onPointerMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      tf.current.x += e.clientX - drag.lx;
      tf.current.y += e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      apply();
    };
    const onPointerUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      vp.releasePointerCapture(e.pointerId);
      drag = null;
      vp.style.cursor = "";
    };

    vp.addEventListener("wheel", onWheel, { passive: false });
    vp.addEventListener("gesturestart", onGestureStart, { passive: false });
    vp.addEventListener("gesturechange", onGestureChange, { passive: false });
    vp.addEventListener("gestureend", onGestureEnd, { passive: false });
    vp.addEventListener("pointerdown", onPointerDown);
    vp.addEventListener("pointermove", onPointerMove);
    vp.addEventListener("pointerup", onPointerUp);
    vp.addEventListener("pointercancel", onPointerUp);

    // On first paint, fit the content to the viewport so wide
    // banners (1584px) aren't clipped at scale 1.
    requestAnimationFrame(() => {
      const w = worldRef.current;
      if (!w) return;
      const r = vp.getBoundingClientRect();
      const wb = w.getBoundingClientRect();
      const fit = Math.min((r.width - 80) / Math.max(wb.width, 1), 1);
      if (fit < 1) {
        tf.current.scale = fit;
        tf.current.x = (r.width - wb.width * fit) / 2;
        tf.current.y = 30;
        apply();
      }
    });

    return () => {
      vp.removeEventListener("wheel", onWheel);
      vp.removeEventListener("gesturestart", onGestureStart);
      vp.removeEventListener("gesturechange", onGestureChange);
      vp.removeEventListener("gestureend", onGestureEnd);
      vp.removeEventListener("pointerdown", onPointerDown);
      vp.removeEventListener("pointermove", onPointerMove);
      vp.removeEventListener("pointerup", onPointerUp);
      vp.removeEventListener("pointercancel", onPointerUp);
    };
  }, [apply, minScale, maxScale]);

  const gridSvg = `url("data:image/svg+xml,%3Csvg width='120' height='120' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M120 0H0v120' fill='none' stroke='${encodeURIComponent(DC.grid)}' stroke-width='1'/%3E%3C/svg%3E")`;

  return (
    <div
      ref={vpRef}
      className="design-canvas"
      style={{
        height: "100vh",
        width: "100vw",
        background: DC.bg,
        backgroundImage: gridSvg,
        backgroundRepeat: "repeat",
        backgroundPosition: "0 0",
        backgroundSize: "120px 120px",
        overflow: "hidden",
        overscrollBehavior: "none",
        touchAction: "none",
        position: "relative",
        fontFamily: DC.font,
        boxSizing: "border-box",
        ...style,
      }}
    >
      <div
        ref={worldRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transformOrigin: "0 0",
          width: "max-content",
          minWidth: "100%",
          minHeight: "100%",
          padding: "60px 0 80px",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* DCSection */

function DCSection({ id, title, subtitle, children, gap = 48 }) {
  const ctx = useContext(DCCtx);
  const sid = id != null ? id : title;
  const all = Children.toArray(children);
  const artboards = all.filter(
    (c) => isValidElement(c) && c.type === DCArtboard
  );
  const rest = all.filter((c) => !(isValidElement(c) && c.type === DCArtboard));
  const srcOrder = artboards.map((a) => (a.props.id != null ? a.props.id : a.props.label));
  const sec = (ctx && sid && ctx.section(sid)) || {};

  const order = useMemo(() => {
    const kept = (sec.order || []).filter((k) => srcOrder.includes(k));
    return [...kept, ...srcOrder.filter((k) => !kept.includes(k))];
  }, [sec.order, srcOrder.join("|")]);

  const byId = Object.fromEntries(
    artboards.map((a) => [(a.props.id != null ? a.props.id : a.props.label), a])
  );

  return (
    <div
      data-dc-section={sid}
      style={{
        marginBottom: 80,
        position: "relative",
        willChange: "transform",
        contain: "paint",
      }}
    >
      <div style={{ padding: "0 60px 56px" }}>
        <DCEditable
          tag="div"
          value={sec.title != null ? sec.title : title}
          onChange={(v) => ctx && ctx.patchSection(sid, { title: v })}
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: DC.title,
            letterSpacing: -0.4,
            marginBottom: 6,
            display: "inline-block",
          }}
        />
        {subtitle && <div style={{ fontSize: 16, color: DC.subtitle }}>{subtitle}</div>}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap,
          padding: "0 60px",
          alignItems: "flex-start",
          width: "max-content",
        }}
      >
        {order.map((k) => (
          <DCArtboardFrame
            key={k}
            sectionId={sid}
            artboard={byId[k]}
            order={order}
            label={(sec.labels || {})[k] != null ? (sec.labels || {})[k] : byId[k].props.label}
            onRename={(v) =>
              ctx &&
              ctx.patchSection(sid, (x) => ({
                labels: { ...(x.labels || {}), [k]: v },
              }))
            }
            onReorder={(next) => ctx && ctx.patchSection(sid, { order: next })}
            onFocus={() => ctx && ctx.setFocus(`${sid}/${k}`)}
          />
        ))}
      </div>
      {rest}
    </div>
  );
}

/* DCArtboard — marker; rendered by DCArtboardFrame */

function DCArtboard(_) { return null; }

function DCArtboardFrame({
  sectionId,
  artboard,
  label,
  order,
  onRename,
  onReorder,
  onFocus,
}) {
  const { id: rawId, label: rawLabel, width = 260, height = 480, children, style = {} } =
    artboard.props;
  const id = rawId != null ? rawId : rawLabel;
  const ref = useRef(null);

  return (
    <div ref={ref} data-dc-slot={id} style={{ position: "relative", flexShrink: 0 }}>
      <div
        className="dc-labelrow"
        style={{
          position: "absolute",
          bottom: "100%",
          left: -4,
          marginBottom: 4,
          color: DC.label,
        }}
      >
        <div className="dc-labeltext" onClick={onFocus} title="Click to focus">
          <DCEditable
            value={label}
            onChange={onRename}
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 15, fontWeight: 500, color: DC.label, lineHeight: 1 }}
          />
        </div>
      </div>
      <button
        className="dc-expand"
        onClick={onFocus}
        onPointerDown={(e) => e.stopPropagation()}
        title="Focus"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
        >
          <path d="M7 1h4v4M5 11H1V7M11 1L7.5 4.5M1 11l3.5-3.5" />
        </svg>
      </button>
      <div
        className="dc-card"
        style={{
          borderRadius: 2,
          boxShadow: "0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06)",
          overflow: "hidden",
          width,
          height,
          background: "#fff",
          ...style,
        }}
      >
        {children || (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#bbb",
              fontSize: 13,
              fontFamily: DC.font,
            }}
          >
            {id}
          </div>
        )}
      </div>
    </div>
  );
}

/* DCEditable */

function DCEditable({ value, onChange, style, tag = "span", onClick }) {
  const Tag = tag;
  return (
    <Tag
      className="dc-editable"
      contentEditable
      suppressContentEditableWarning
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => onChange && onChange(e.currentTarget.textContent || "")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      style={style}
    >
      {value}
    </Tag>
  );
}

/* Focus overlay (trimmed — banners don't need full carousel logic, but kept for parity) */

function DCFocusOverlay({ entry, sectionMeta, sectionOrder }) {
  const ctx = useContext(DCCtx);
  const { sectionId, artboard } = entry;
  const meta = sectionMeta[sectionId];
  const peers = meta.slotIds;
  const aid = artboard.props.id != null ? artboard.props.id : artboard.props.label;
  const idx = peers.indexOf(aid);

  const go = (d) => {
    const n = peers[(idx + d + peers.length) % peers.length];
    if (n) ctx.setFocus(`${sectionId}/${n}`);
  };

  useEffect(() => {
    const k = (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  const { width = 260, height = 480, children } = artboard.props;
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const r = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  const scale = Math.max(0.05, Math.min((vp.w - 200) / width, (vp.h - 200) / height, 2));

  return createPortal(
    <div
      onClick={() => ctx.setFocus(null)}
      onWheel={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(24,20,16,.7)",
        backdropFilter: "blur(14px)",
        fontFamily: DC.font,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: width * scale, height: height * scale, position: "relative" }}>
        <div
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            background: "#fff",
            borderRadius: 2,
            overflow: "hidden",
            boxShadow: "0 20px 80px rgba(0,0,0,.4)",
          }}
        >
          {children}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); ctx.setFocus(null); }}
        style={{
          position: "absolute",
          top: 20,
          right: 20,
          border: "none",
          background: "rgba(255,255,255,.1)",
          color: "#fff",
          width: 36,
          height: 36,
          borderRadius: 18,
          fontSize: 22,
          cursor: "pointer",
          lineHeight: 1,
        }}
      >×</button>
    </div>,
    document.body
  );
}

/* DCPostIt */

function DCPostIt({ children, top, left, right, bottom, rotate = -2, width = 180 }) {
  return (
    <div
      style={{
        position: "absolute",
        top,
        left,
        right,
        bottom,
        width,
        background: DC.postitBg,
        padding: "14px 16px",
        fontFamily: '"Comic Sans MS", "Marker Felt", "Segoe Print", cursive',
        fontSize: 14,
        lineHeight: 1.4,
        color: DC.postitText,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)",
        transform: `rotate(${rotate}deg)`,
        zIndex: 5,
      }}
    >
      {children}
    </div>
  );
}

window.DesignCanvas = DesignCanvas;
window.DCSection = DCSection;
window.DCArtboard = DCArtboard;
window.DCPostIt = DCPostIt;
