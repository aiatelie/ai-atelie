/* inject-script.js — runs inside the iframe, exposes a DM command bus
 * over postMessage. Provides the host with selection state, computed
 * styles, and an inline-style command channel.
 *
 * Public surface:
 *   - DM-stamps elements with `data-dm-ref` LAZILY (only when something
 *     asks for the ref via getRef). No eager walk, no MutationObserver.
 *   - Listens for { __DM_CMD__: { type, ... } } from the parent window.
 *   - Emits { __DM_MSG__: { type, ... } } back via parent.postMessage.
 *
 * Outbound message types:
 *   ready         { v }
 *   selection     { ref, tag, rect, computed, descriptor }
 *   hover         { ref, rect, tag } | { ref: null }
 *   pong          {}
 *   undoDepth     { depth }   — emitted after snapshot/undo
 *   runtime-error { message, filename?, lineno?, colno?, stack?, source, timestamp }
 *
 * Inbound command types:
 *   ping          {}
 *   pick          { x, y, select?, extend? }       → emits selection or hover
 *   hoverRef      { ref | null }                   → emits hover
 *   describe      { ref }                          → emits selection
 *   setStyles     { ref, styles: { prop: value } }
 *   setText       { ref, text }
 *   snapshot      {}                               — push closure-undo barrier
 *   undo          {}                               — pop closure-undo barrier
 */

(function() {
  if (window.__DM_INJECTED__) return;
  window.__DM_INJECTED__ = true;

  // ─── Ref registry ──────────────────────────────────────────────
  // Lazy: getRef stamps on demand, never on a doc-wide walk. Refs are
  // integers (not "r1"/"r2") to match the bundle we mirror.
  var nextRef = 1;
  var refMap = Object.create(null); // ref → Element

  function getRef(el) {
    if (!el || el.nodeType !== 1) return null;
    var existing = el.getAttribute("data-dm-ref");
    if (existing) return parseInt(existing, 10);
    var r = nextRef++;
    el.setAttribute("data-dm-ref", String(r));
    refMap[r] = el;
    return r;
  }

  function byRef(ref) {
    var el = refMap[ref];
    if (el && el.isConnected) return el;
    // Fallback: query the DOM. Survives the case where React replaced
    // the node but kept the data-dm-ref attribute. Without this, refs
    // go stale every time the framework rerenders.
    el = document.querySelector('[data-dm-ref="' + ref + '"]');
    if (el) refMap[ref] = el;
    return el || null;
  }

  // ─── Geometry / style helpers ──────────────────────────────────
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function computedSubset(el) {
    var cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return {
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      display: cs.display,
      position: cs.position,
    };
  }

  // ─── Rich descriptor ───────────────────────────────────────────
  // Mirrors web/src/lib/cssPath.ts buildDescriptor — kept as a
  // drop-in so the parent can pull a profile straight from the iframe
  // (used by `pick` and `describe` commands). The parent ALSO has
  // its own builder so it can describe an element without a round-trip.
  var DESCRIPTOR_ATTRS = ["href", "src", "alt", "title", "name", "type", "placeholder"];
  var SEMANTIC_TAGS = {
    header: 1, footer: 1, main: 1, nav: 1, aside: 1, section: 1, article: 1,
    form: 1, ul: 1, ol: 1, li: 1, table: 1, tr: 1, td: 1, th: 1, figure: 1,
    dialog: 1, details: 1, summary: 1, button: 1, label: 1,
  };

  function classListOf(el) {
    var raw = el.getAttribute("class") || "";
    var parts = [];
    var split = raw.split(/\s+/);
    for (var i = 0; i < split.length && parts.length < 4; i++) {
      if (split[i]) parts.push(split[i]);
    }
    return parts;
  }

  function signatureOf(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.getAttribute("id");
    if (id) return tag + "#" + id;
    var classes = classListOf(el);
    if (classes.length) return tag + "." + classes.join(".");
    var role = el.getAttribute("role");
    if (role) return tag + "[role=" + role + "]";
    var testId = el.getAttribute("data-testid");
    if (testId) return tag + "[data-testid=" + testId + "]";
    return tag;
  }

  function shortTextOf(el) {
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) return null;
    return t.length > 80 ? t.slice(0, 77) + "…" : t;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName.toLowerCase();
    var classes = classListOf(el);
    var id = el.getAttribute("id") || undefined;
    var role = el.getAttribute("role") || undefined;
    var ariaLabel = el.getAttribute("aria-label") || undefined;
    var testId = el.getAttribute("data-testid") || undefined;
    var text = shortTextOf(el);

    var attrs = {};
    for (var i = 0; i < DESCRIPTOR_ATTRS.length; i++) {
      var name = DESCRIPTOR_ATTRS[i];
      var v = el.getAttribute(name);
      if (v) attrs[name] = v.length > 60 ? v.slice(0, 57) + "…" : v;
    }
    var hasAttrs = Object.keys(attrs).length > 0;

    // Ancestor chain: skip noise wrapper-divs (no class, no id, no
    // semantic tag) — they make the AI's mental picture worse.
    var ancestors = [];
    var cur = el.parentElement;
    while (cur && cur !== document.body && ancestors.length < 5) {
      var ctag = cur.tagName.toLowerCase();
      var noise = ctag === "div" && !cur.id && classListOf(cur).length === 0;
      if (!noise) ancestors.push(signatureOf(cur));
      cur = cur.parentElement;
    }
    ancestors.push("body");

    // Sibling position (only when there's contention).
    var siblingIndex, siblingTotal;
    var parent = el.parentElement;
    if (parent) {
      var sameTag = [];
      for (var j = 0; j < parent.children.length; j++) {
        if (parent.children[j].tagName === el.tagName) sameTag.push(parent.children[j]);
      }
      if (sameTag.length > 1) {
        siblingIndex = sameTag.indexOf(el) + 1;
        siblingTotal = sameTag.length;
      }
    }

    // Nearest semantic ancestor for the label.
    var semantic = "";
    var sc = el.parentElement;
    while (sc && sc !== document.body) {
      var sctag = sc.tagName.toLowerCase();
      if (SEMANTIC_TAGS[sctag] || sc.id || classListOf(sc).length > 0) {
        semantic = signatureOf(sc);
        break;
      }
      sc = sc.parentElement;
    }

    var sig = signatureOf(el);
    var labelParts = ["<" + sig + ">"];
    if (text) labelParts.push('"' + (text.length > 40 ? text.slice(0, 37) + "…" : text) + '"');
    if (semantic) labelParts.push("inside <" + semantic + ">");
    if (siblingIndex && siblingTotal) labelParts.push("(" + siblingIndex + " of " + siblingTotal + ")");

    var out = {
      label: labelParts.join(" "),
      tag: tag,
      classes: classes,
      ancestors: ancestors,
    };
    if (text) out.text = text;
    if (id) out.id = id;
    if (role) out.role = role;
    if (ariaLabel) out.ariaLabel = ariaLabel;
    if (testId) out.testId = testId;
    if (hasAttrs) out.attrs = attrs;
    if (siblingIndex) { out.siblingIndex = siblingIndex; out.siblingTotal = siblingTotal; }
    return out;
  }

  // ─── postMessage envelope ──────────────────────────────────────
  function emit(msg) {
    try { window.parent.postMessage({ __DM_MSG__: msg }, "*"); } catch (e) {}
  }

  // ─── Closure-based undo stack ─────────────────────────────────
  // Replaces our previous "snapshot every inline-style attribute"
  // approach with a closure-based undo: each mutating command pushes
  // a closure that REVERSES it. Cheaper, and supports more than just
  // style mutations (e.g. text changes).
  var UNDO = [];
  var UNDO_MAX = 60;
  function pushUndo(fn) {
    UNDO.push(fn);
    if (UNDO.length > UNDO_MAX) UNDO.shift();
    emit({ type: "undoDepth", depth: UNDO.length });
  }
  function popUndo() {
    var fn = UNDO.pop();
    if (!fn) {
      emit({ type: "undoDepth", depth: 0, empty: true });
      return;
    }
    try { fn(); } catch (e) { /* ignore — best-effort */ }
    emit({ type: "undoDepth", depth: UNDO.length, restored: true });
  }

  // ─── Inspector skip-list ──────────────────────────────────────
  // Any element marked with `data-cc-no-inspect` (or any descendant
  // of one) is INVISIBLE to the hover-select / click-to-pick flow.
  // Used by tweak panels, the ⌘ Tweaks FAB, and any other editor-UI
  // overlay that lives inside the iframe but isn't part of the user's
  // design. Convention: emit the attribute on the OUTERMOST root the
  // user shouldn't be able to inspect — `closest()` walks up so a
  // single marker covers the whole subtree.
  function isOptedOut(el) {
    if (!el || el.nodeType !== 1) return false;
    return !!el.closest("[data-cc-no-inspect]");
  }

  // ─── Pick: hit-test with drill-into-selection ─────────────────
  // Uses elementsFromPoint (plural) for the full stacking-order
  // stack at (x, y). When clicking inside the current primary,
  // prefer it/descendants over whatever happens to be topmost via
  // z-index. Mirrors the bundle's drill behavior — without it,
  // newly-inserted elements are unselectable from the iframe surface
  // because the sibling on top steals the click.
  var primaryRef = null;

  function pickAt(x, y) {
    var stack = document.elementsFromPoint(x, y) || [];
    // Skip-list: drill PAST any opted-out element (and its subtree)
    // so the inspector behaves as if those overlays don't exist. If
    // every candidate at (x, y) is opted-out, return null and let the
    // caller bail.
    var el = null;
    for (var s = 0; s < stack.length; s++) {
      if (!isOptedOut(stack[s])) { el = stack[s]; break; }
    }
    if (!el) return null;
    if (el === document.documentElement) el = document.body;
    if (primaryRef !== null) {
      var primary = byRef(primaryRef);
      if (primary && primary !== el && !primary.contains(el)) {
        for (var i = 1; i < stack.length; i++) {
          if (isOptedOut(stack[i])) continue;
          if (stack[i] === primary || primary.contains(stack[i])) {
            el = stack[i];
            break;
          }
        }
      }
    }
    return el;
  }

  function emitSelection(el) {
    var ref = getRef(el);
    primaryRef = ref;
    emit({
      type: "selection",
      ref: ref,
      tag: el.tagName.toLowerCase(),
      rect: rectOf(el),
      computed: computedSubset(el),
      innerText: (el.innerText || "").slice(0, 280),
      descriptor: describe(el),
    });
  }

  // ─── Re-emit rects on scroll/resize ───────────────────────────
  // Matches the bundle's `addEventListener('scroll', onViewChange,
  // true)` — capture=true so any scrolling container fires it. Our
  // outline overlay (parent-side) needs to re-align when the iframe
  // itself scrolls, since rects are in iframe-viewport coords.
  var rafPending = false;
  function onViewChange() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      if (primaryRef === null) return;
      var el = byRef(primaryRef);
      if (!el) return;
      emit({ type: "rect", ref: primaryRef, rect: rectOf(el) });
    });
  }

  // ─── Command handler ──────────────────────────────────────────
  function handle(cmd) {
    if (!cmd || typeof cmd !== "object") return;
    switch (cmd.type) {
      case "ping": emit({ type: "pong" }); return;

      case "pick": {
        var el = pickAt(cmd.x | 0, cmd.y | 0);
        // pickAt returns null when every candidate at (x, y) is
        // opted-out via data-cc-no-inspect. Clear any stale hover
        // outline on the parent side so the orange box disappears
        // when the cursor moves OVER a tweak panel / FAB.
        if (!el) {
          if (!cmd.select) emit({ type: "hover", ref: null });
          return;
        }
        if (cmd.select) {
          emitSelection(el);
        } else {
          var ref = getRef(el);
          emit({ type: "hover", ref: ref, rect: rectOf(el), tag: el.tagName.toLowerCase() });
        }
        return;
      }

      case "hoverRef": {
        if (cmd.ref == null) { emit({ type: "hover", ref: null }); return; }
        var hel = byRef(cmd.ref);
        if (!hel) { emit({ type: "hover", ref: null }); return; }
        // Skip-list: if the parent asks us to outline an opted-out
        // element by ref, treat it as no hover. Belt-and-suspenders —
        // pickAt already filters, but a stale ref could still get here.
        if (isOptedOut(hel)) { emit({ type: "hover", ref: null }); return; }
        emit({ type: "hover", ref: cmd.ref, rect: rectOf(hel), tag: hel.tagName.toLowerCase() });
        return;
      }

      case "describe": {
        var del = byRef(cmd.ref);
        if (!del) return;
        // Skip-list: refuse to describe opted-out elements so they
        // never end up in the parent's selection state.
        if (isOptedOut(del)) return;
        emitSelection(del);
        return;
      }

      case "setStyles": {
        var sel = byRef(cmd.ref);
        if (!sel || !cmd.styles) return;
        // Capture only the props we're about to change — cheaper than
        // snapshotting the whole inline-style attribute, and gives a
        // surgical reverse-op for pushUndo.
        var prev = {};
        var keys = Object.keys(cmd.styles);
        for (var k = 0; k < keys.length; k++) {
          prev[keys[k]] = sel.style.getPropertyValue(keys[k]);
        }
        pushUndo(function() {
          for (var k2 = 0; k2 < keys.length; k2++) {
            var pv = prev[keys[k2]];
            if (pv) sel.style.setProperty(keys[k2], pv, "important");
            else sel.style.removeProperty(keys[k2]);
          }
        });
        for (var ki = 0; ki < keys.length; ki++) {
          // !important — inspector live preview must beat the saved
          // _inspector_edits.css which itself uses !important.
          sel.style.setProperty(keys[ki], cmd.styles[keys[ki]], "important");
        }
        return;
      }

      case "setText": {
        var tel = byRef(cmd.ref);
        if (!tel) return;
        var before = tel.textContent || "";
        pushUndo(function() { tel.textContent = before; });
        tel.textContent = cmd.text || "";
        return;
      }

      case "setPositionMode": {
        // Flip an element's CSS `position`. When switching to absolute/
        // fixed we compute left/top so the element STAYS at its current
        // visual location. Without that, the element snaps to (0,0)
        // which is never what the user wanted.
        var pel = byRef(cmd.ref);
        if (!pel || !cmd.mode) return;
        var pcs = pel.ownerDocument.defaultView.getComputedStyle(pel);
        var snap = pel.style.cssText;
        pushUndo(function() { pel.style.cssText = snap; });
        if (cmd.mode === "static") {
          pel.style.position = "";
          pel.style.left = ""; pel.style.top = "";
          pel.style.right = ""; pel.style.bottom = "";
        } else if (cmd.mode === "relative") {
          pel.style.position = "relative";
        } else if (cmd.mode === "absolute" || cmd.mode === "fixed") {
          var pr = pel.getBoundingClientRect();
          if (cmd.mode === "fixed") {
            pel.style.position = "fixed";
            pel.style.left = Math.round(pr.left) + "px";
            pel.style.top = Math.round(pr.top) + "px";
          } else {
            // absolute: offset from positioned ancestor (offsetParent), so
            // the element stays exactly where it was visually.
            var ancestor = pel.offsetParent || pel.ownerDocument.body;
            var ar = ancestor.getBoundingClientRect();
            pel.style.position = "absolute";
            pel.style.left = Math.round(pr.left - ar.left) + "px";
            pel.style.top = Math.round(pr.top - ar.top) + "px";
          }
        }
        // Re-emit selection so the parent's overlay rect tracks the new
        // box (positioning may have changed it).
        if (primaryRef !== null) {
          var pre = byRef(primaryRef);
          if (pre) emit({ type: "rect", ref: primaryRef, rect: rectOf(pre) });
        }
        emit({ type: "positionModeChanged", ref: cmd.ref, mode: cmd.mode, before: pcs.position });
        return;
      }

      case "snapshot": {
        // Insert a no-op barrier — useful as a manual checkpoint
        // before a series of mutations the caller wants to undo as one.
        pushUndo(function() {});
        return;
      }
      case "undo": popUndo(); return;
    }
  }

  // ─── Listeners ─────────────────────────────────────────────────
  window.addEventListener("message", function(e) {
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (!data.__DM_CMD__) return;
    handle(data.__DM_CMD__);
  });

  // Editor "pan mode" freeze: when the editor is zoomed out far
  // enough that frames look like thumbnails, it sets
  // <html data-cc-frozen="1"> on us, and we kill all CSS animations
  // and transitions while the attribute is present. This stops the
  // iframe from doing layout/paint work the user can't even see at
  // that zoom — a big win on heavy pages with 30+ frames.
  function installFreezeCSS() {
    try {
      var style = document.createElement("style");
      style.setAttribute("data-cc-freeze-style", "");
      style.textContent =
        "html[data-cc-frozen] *," +
        "html[data-cc-frozen] *::before," +
        "html[data-cc-frozen] *::after {" +
        "  animation-play-state: paused !important;" +
        "  transition: none !important;" +
        "}";
      (document.head || document.documentElement).appendChild(style);
    } catch (e) { /* ignore */ }
  }

  // ─── Runtime-error surfacing ───────────────────────────────────
  // Same-origin iframe means we can listen for JS throws in the artifact
  // and forward them to the host UI for an in-canvas error overlay. The
  // host throttles + dedupes; we keep the iframe-side pure passthrough so
  // the listener is impossible to misorder against artifact code.
  function emitRuntimeError(payload) {
    emit({
      type: "runtime-error",
      message: payload.message || "Unknown error",
      filename: payload.filename || null,
      lineno: payload.lineno || null,
      colno: payload.colno || null,
      stack: payload.stack || null,
      source: payload.source || "error",
      timestamp: Date.now(),
    });
  }
  window.addEventListener("error", function(e) {
    // Resource-load failures (img/script 404) fire `error` on the
    // element with no `message`. Skip those — they're noisy and the user
    // can already see the broken element. Only surface real script throws.
    if (!e.message && !e.error) return;
    emitRuntimeError({
      message: e.message || (e.error && e.error.message) || "Script error",
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack,
      source: "error",
    });
  });
  window.addEventListener("unhandledrejection", function(e) {
    var reason = e.reason;
    var msg = (reason && reason.message) ? reason.message : String(reason);
    emitRuntimeError({
      message: "Unhandled promise rejection: " + msg,
      stack: reason && reason.stack,
      source: "unhandledrejection",
    });
  });

  function ready() {
    window.addEventListener("scroll", onViewChange, true);
    window.addEventListener("resize", onViewChange);
    installFreezeCSS();
    emit({ type: "ready", v: 2 });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
})();
