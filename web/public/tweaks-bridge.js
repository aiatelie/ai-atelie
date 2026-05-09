/* tweaks-bridge.js — auto-injected iframe-side bridge for the Tweaks
 * protocol. Runs inside every project preview HTML page so the host
 * editor can render a Tweaks sidebar without the artifact having to
 * ship its own panel.
 *
 * Contract (host ↔ iframe):
 *
 *   iframe → host  __edit_mode_available  { defaults: {…} }
 *                  Sent on load if the document contains an EDITMODE
 *                  block. The `defaults` payload is the parsed JSON,
 *                  which the host uses to render typed controls
 *                  (color/range/text/checkbox).
 *
 *   host  → iframe __activate_edit_mode    {}
 *                  No-op for the auto-bridge (the host owns the panel).
 *                  Kept so legacy artifacts that DO ship their own
 *                  panel still work — those pages set
 *                  `window.__editModeOwned = true` and the auto-bridge
 *                  exits early; the page-shipped listener handles it.
 *
 *   host  → iframe __deactivate_edit_mode  {}
 *                  Same — no-op for auto-bridge.
 *
 *   host  → iframe __edit_mode_set_keys    { edits: { key: value } }
 *                  Apply each edit live. Three layers, in order:
 *                    1. If `window.__applyTweaks` exists (function),
 *                       call it with the edits object. Artifact wins.
 *                    2. Update `--<key>` CSS custom property on
 *                       `:root` so any styles using `var(--key)` move.
 *                    3. For elements with `data-tweak-text="<key>"`,
 *                       replace their text content. For elements with
 *                       `data-tweak-attr="<key>:<attr>"` (e.g.
 *                       "headline:title"), set the named attribute.
 *
 *   iframe → host  __edit_mode_dismissed   {}
 *                  Sent when the user presses Escape inside the iframe.
 *                  The host uses this to flip its toggle off.
 *
 * Why a script and not a direct cross-window read of the EDITMODE block?
 * Because the source file may be JSX served via Babel-Standalone — the
 * parsed DOM doesn't contain the JS source as a string we can grep. The
 * cleanest path is: the iframe reads its own raw HTML (always available
 * via XHR to its own URL), parses out the marker, and announces.
 */

(function () {
  if (window.__TWEAKS_BRIDGE_INSTALLED__) return;
  window.__TWEAKS_BRIDGE_INSTALLED__ = true;

  // Pages that ship their own Tweaks panel set this flag — back off
  // entirely so we don't double-announce or fight their listener.
  // Check here (synchronous opt-out from an inline script) and again in
  // start() (deferred opt-out for DOMContentLoaded-order edge cases).
  if (window.__editModeOwned) return;

  // ─── Find an EDITMODE block in the document ────────────────────
  // The marker can live in inline <script>, inline <style>, or the
  // raw HTML before any framework rendered. We walk all three places.
  // The block must be valid JSON; if it isn't, we silently bail.
  var EDITMODE_RE = /\/\*EDITMODE-BEGIN\*\/\s*([\s\S]*?)\s*\/\*EDITMODE-END\*\//;

  function findInline() {
    // Inline <script> blocks first — the most common place artifacts
    // put a TWEAK_DEFAULTS block. document.scripts includes external
    // src= scripts (which have empty .text) and inline ones.
    for (var i = 0; i < document.scripts.length; i++) {
      var s = document.scripts[i];
      var t = s.textContent || "";
      var m = t.match(EDITMODE_RE);
      if (m) return m[1];
    }
    // Inline <style> blocks — the example in the protocol doc.
    var styles = document.getElementsByTagName("style");
    for (var j = 0; j < styles.length; j++) {
      var st = styles[j].textContent || "";
      var ms = st.match(EDITMODE_RE);
      if (ms) return ms[1];
    }
    return null;
  }

  function fetchRaw(url, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.onload = function () {
        try {
          var m = (xhr.responseText || "").match(EDITMODE_RE);
          cb(m ? m[1] : null);
        } catch (e) { cb(null); }
      };
      xhr.onerror = function () { cb(null); };
      xhr.send();
    } catch (e) { cb(null); }
  }

  function fetchRawAndFind(cb) {
    // Fallback for JSX / external-script artifacts: walk every external
    // script we know about (own URL + each <script src>) and stop at
    // the first EDITMODE hit. Same origin, so XHR is safe; serial walk
    // keeps us off the parallel-request flood path for pages with
    // many <script> tags.
    var sources = [location.href];
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].getAttribute("src");
      if (!src) continue;
      // Skip ourselves and well-known third-party scripts (React, Babel)
      // that can't possibly contain an EDITMODE block.
      if (/tweaks-bridge\.js/.test(src)) continue;
      if (/unpkg\.com|cdn\.jsdelivr\.net|googleapis\.com|gstatic\.com/.test(src)) continue;
      sources.push(src);
    }
    var idx = 0;
    function step() {
      if (idx >= sources.length) { cb(null); return; }
      var url = sources[idx++];
      fetchRaw(url, function (hit) {
        if (hit) cb(hit);
        else step();
      });
    }
    step();
  }

  function tryParse(text) {
    if (!text) return null;
    try {
      var j = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch (e) { /* ignore */ }
    return null;
  }

  // ─── Apply incoming edits ──────────────────────────────────────
  function applyEdits(edits) {
    if (!edits || typeof edits !== "object") return;

    // 1. Artifact-defined hook wins. Pages that need bespoke wiring
    //    (e.g. swap a className based on a string key) define this.
    var hook = window.__applyTweaks;
    if (typeof hook === "function") {
      try { hook(edits); } catch (e) { /* fall through */ }
    }

    // 2. CSS custom properties — `--<key>` on :root. The vast majority
    //    of design tweaks (color, size, spacing) work this way without
    //    any JS in the artifact: `body { color: var(--primaryColor); }`.
    var root = document.documentElement;
    Object.keys(edits).forEach(function (k) {
      var v = edits[k];
      var asStr = (typeof v === "boolean" || typeof v === "number") ? String(v) : v;
      if (typeof asStr !== "string") return;
      // Handle bare numbers — coerce to px when the existing value
      // resolved to a length (matches CSS engines' usual expectations).
      // We don't try to be clever; just write the value as-is and let
      // CSS be permissive.
      root.style.setProperty("--" + k, asStr);
    });

    // 3. data-tweak-text="<key>" elements pick up text changes for
    //    string keys. data-tweak-attr="<key>:<attr>" sets attributes.
    Object.keys(edits).forEach(function (k) {
      var v = edits[k];
      var asStr = (typeof v === "string") ? v
                : (typeof v === "number" || typeof v === "boolean") ? String(v) : null;
      if (asStr == null) return;
      var textNodes = document.querySelectorAll('[data-tweak-text="' + cssEscape(k) + '"]');
      for (var i = 0; i < textNodes.length; i++) {
        textNodes[i].textContent = asStr;
      }
      var attrNodes = document.querySelectorAll('[data-tweak-attr^="' + cssEscape(k) + ':"]');
      for (var j = 0; j < attrNodes.length; j++) {
        var spec = attrNodes[j].getAttribute("data-tweak-attr") || "";
        var idx = spec.indexOf(":");
        if (idx < 0) continue;
        var name = spec.slice(idx + 1);
        if (!name) continue;
        attrNodes[j].setAttribute(name, asStr);
      }
    });
  }

  // CSS.escape polyfill for older browsers / non-standard environments.
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
  }

  // ─── Listener wiring ───────────────────────────────────────────
  // Per the protocol doc, register the listener BEFORE announcing
  // availability — otherwise an immediate __activate_edit_mode could
  // arrive before we're ready.
  function registerListener() {
    window.addEventListener("message", function (e) {
      // Security: only accept messages from the host (parent) window.
      // Both sides are same-origin, so we gate on source AND origin to
      // prevent hostile frames or sibling windows from injecting edits.
      if (e.source !== window.parent) return;
      if (e.origin !== window.location.origin) return;
      var data = e.data;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      switch (data.type) {
        case "__activate_edit_mode":
          // No-op — the host owns the panel. Hook left for parity in
          // case future versions want to e.g. inject an outline.
          break;
        case "__deactivate_edit_mode":
          break;
        case "__edit_mode_set_keys":
          if (data.edits && typeof data.edits === "object") applyEdits(data.edits);
          break;
      }
    });
    // Escape key inside the iframe → tell the host to close its panel.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        try {
          // Use explicit origin — both sides are same-origin.
          window.parent.postMessage({ type: "__edit_mode_dismissed" }, window.location.origin);
        } catch (err) { /* ignore */ }
      }
    });
  }

  function announce(defaults) {
    if (!defaults) return;
    try {
      // Use explicit origin — both sides are same-origin.
      window.parent.postMessage({
        type: "__edit_mode_available",
        defaults: defaults,
      }, window.location.origin);
    } catch (e) { /* ignore */ }
  }

  function start() {
    // Re-check opt-out here too: an artifact whose script runs during
    // DOMContentLoaded (same phase as this bridge) may have set the flag
    // after the top-of-IIFE check ran but before start() fires. Truthy
    // check matches any value the artifact might assign (true, 1, "yes").
    if (window.__editModeOwned) return;
    // First try inline blocks — fastest path, no network.
    var inline = tryParse(findInline());
    if (inline) {
      registerListener();
      // Apply defaults once at startup so any saved state already
      // reflected in the source flows into CSS variables before paint
      // settles (purely cosmetic — values may already match).
      applyEdits(inline);
      announce(inline);
      return;
    }
    // Fallback to a raw fetch of our own URL. Artifacts that do all
    // their work in JSX served via Babel-Standalone end up here —
    // the EDITMODE block lives in JSX source the parsed DOM can't see.
    fetchRawAndFind(function (raw) {
      if (window.__editModeOwned) return;
      var parsed = tryParse(raw);
      if (!parsed) return;
      registerListener();
      applyEdits(parsed);
      announce(parsed);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
