/* capabilities.ts — provider-agnostic registry of "things the AI / UI
 * can ask the host to do".
 *
 * Each capability is a self-describing record:
 *   - id        — stable string used by adapters and the AI as the tool name
 *   - name      — short human-readable title
 *   - description — what it does, written for the AI (and for humans
 *                   reading the registry)
 *   - inputSchema — JSON Schema for the args
 *   - method, endpoint — the HTTP entry point that runs it
 *   - returns   — describes the response so adapters can surface it
 *                 sensibly to the model (e.g. binary vs JSON)
 *
 * The registry is the *single source of truth*. Multiple adapters consume
 * it without each owning its own copy:
 *
 *   • Toolbar UI — calls the `endpoint` directly via fetch (today). It
 *     could optionally fetch /api/capabilities to render a dynamic menu
 *     but it doesn't have to.
 *   • Claude (today, via the Agent SDK's MCP support) —
 *     mcp/capabilities-server.mjs reads /api/capabilities at boot and
 *     publishes each entry as an MCP tool whose handler HTTP-POSTs back
 *     to `endpoint`.
 *   • OpenAI / OpenRouter / Gemini / Ollama (future) — write a small
 *     adapter that reads /api/capabilities, converts each entry to the
 *     provider's `tools` array shape, and routes tool_use calls back to
 *     the endpoint via fetch.
 *
 * Nothing in this file knows what an MCP is. That's deliberate: adding a
 * new capability is a single object literal here, plus its endpoint.
 * Pulling out MCP later (or replacing it with a different agent runtime)
 * doesn't touch this file.
 */

export type CapabilityCategory = "export" | "ask" | "files" | "design";

export type ResponseShape =
  | { kind: "binary"; contentTypes: string[]; downloadByDefault: boolean }
  | { kind: "json"; schema?: Record<string, unknown> }
  | { kind: "text" };

export type Capability = {
  /** Stable identifier — also used as the AI tool name. snake_case so
   *  it slots cleanly into OpenAI / Anthropic tool_use conventions. */
  id: string;
  /** Short human-readable title. */
  name: string;
  /** AI-facing description: what it does, when to use it, what to
   *  expect back. Keep it tight (1–3 sentences) — the model will see
   *  the description for every tool every turn. */
  description: string;
  /** JSON Schema for the input args. Plain JSON Schema (Draft 2020-12
   *  shape), no provider-specific extensions. Adapters wrap it as
   *  needed (e.g. MCP wraps in `inputSchema`, OpenAI wraps in
   *  `parameters`). */
  inputSchema: Record<string, unknown>;
  /** HTTP method + relative path of the runner endpoint. Adapters POST
   *  the AI's args to this URL and forward the response. */
  method: "GET" | "POST";
  endpoint: string;
  /** What the runner returns. Tells adapters whether to expose bytes
   *  (download / file path) or structured data (back to the model). */
  returns: ResponseShape;
  /** Loose grouping for UI / docs. Not used by adapters. */
  category: CapabilityCategory;
};

/** All export capabilities now return an artifact envelope:
 *    { ok, kind, filename, url, mime, bytes, metadata }
 *  where `url` points at /p/<projectId>/exports/<filename> (served by
 *  the projects static plugin). Adapters surface this JSON to whatever
 *  client called the capability — the chat ArtifactCard renders an
 *  inline preview, the toolbar fetches the URL to trigger a download. */
const ARTIFACT_RETURN: ResponseShape = {
  kind: "json",
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      kind: { type: "string", enum: ["image", "video", "html-graphics", "lottie", "asset"] },
      filename: { type: "string" },
      url: { type: "string" },
      mime: { type: "string" },
      bytes: { type: "integer" },
      metadata: { type: "object" },
    },
  },
};

export const CAPABILITIES: Capability[] = [
  {
    id: "export_element",
    name: "Export element as image",
    description:
      "Render a specific element from the active design as a PNG or JPEG using a real headless Chromium (handles canvas, video, backdrop-filter, mix-blend-mode). Saves to web/projects/<id>/exports/<filename> and returns an artifact envelope { ok, kind, filename, url, mime, bytes }. The host's chat ArtifactCard renders an inline preview from `url`. Do NOT narrate file creation in your reply — just state what was saved in one sentence.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Active project id." },
        route: { type: "string", description: "Project-relative path to the page (e.g. '02 Opening Title.html')." },
        selector: { type: "string", description: "CSS selector for the element to capture." },
        scale: { type: "integer", minimum: 1, maximum: 4, description: "Pixel scale (deviceScaleFactor). 1–4. Default 2." },
        format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format. Default png." },
        backgroundColor: { type: ["string", "null"], description: "'transparent' or 'white'. Default transparent." },
        quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG only, 1–100." },
        name: { type: "string", description: "Semantic basename, no extension. Pick something descriptive — 'cat-banner-thumbnail' over 'export'. Server sanitizes + collision-suffixes." },
      },
      required: ["projectId", "route", "selector"],
    },
    method: "POST",
    endpoint: "/api/export-element",
    returns: ARTIFACT_RETURN,
    category: "export",
  },
  {
    id: "export_video",
    name: "Export element as video",
    description:
      "Record the targeted element with a real headless Chromium and encode to MP4 (H.264) or .mov (ProRes 4444 with alpha). Captures live animation — CSS transitions, Lottie, requestAnimationFrame loops — using a virtualized clock so the animation plays at its NATURAL speed regardless of fps (fps only changes sample density / smoothness, never speed). Returns an artifact envelope. Pick `backgroundColor: 'transparent'` to get ProRes 4444 with real alpha; 'black' for the classic luma-key trick (small H.264 file, drop on Resolve and set Composite Mode = Add to make black invisible). Resolution drives deviceScaleFactor — vector / text content stays crisp at 4K because the browser re-rasterizes at higher DPI. Default duration is 'auto', which detects the natural animation length from CSS / Lottie.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        route: { type: "string" },
        selector: { type: "string" },
        resolution: { type: "string", enum: ["1080p", "1440p", "4K", "8K", "custom"], description: "Target output resolution. Default '4K' — the user works in 4K, so high resolution is the expected baseline. Only drop below 4K if the user explicitly asks for a smaller file." },
        customWidth: { type: "integer", description: "Required if resolution='custom'." },
        customHeight: { type: "integer", description: "Required if resolution='custom'." },
        quality: { type: "string", enum: ["draft", "standard", "high", "master"], description: "draft=H.264 CRF 28; standard=CRF 23; high=CRF 18; master=ProRes 4444 if transparent else H.264 CRF 14. Default 'high' — the user wants high-quality output by default. Use 'master' for hero/delivery, drop lower only when the user asks for a smaller file." },
        duration: { description: "Either a number of seconds (0.5–60) or the string 'auto'. 'auto' inspects CSS animations + Lottie players in the captured subtree and uses the longest natural length found (capped at 30s). Prefer 'auto' unless the user explicitly asks for a specific length — it produces a video that matches the source animation's natural duration. Default 'auto'.", oneOf: [ { type: "number", minimum: 0.5, maximum: 60 }, { type: "string", enum: ["auto"] } ] },
        fps: { type: "integer", enum: [24, 30, 60], description: "Frame rate. Default 30." },
        backgroundColor: { type: "string", enum: ["transparent", "black", "white"], description: "transparent → ProRes 4444 with alpha; black → H.264 (luma-key in NLE with Composite Mode 'Add'); white → H.264 opaque. Default 'transparent'." },
        name: { type: "string", description: "Semantic basename, no extension." },
      },
      required: ["projectId", "route", "selector"],
    },
    method: "POST",
    endpoint: "/api/export-video",
    returns: ARTIFACT_RETURN,
    category: "export",
  },
  {
    id: "export_ograf",
    name: "Export element as DaVinci Resolve OGraf bundle",
    description:
      "Bundle an element (or whole page) as an EBU OGraf HTML graphics package (.ograf.zip) for DaVinci Resolve 21+ Media Pool. HTML, CSS, fonts and images are all inlined — the bundle is fully self-contained. Animations stay seekable on Resolve's timeline; declared `props` become editable fields in Resolve's OGraf inspector. ALWAYS run a short ask_user elicitation first (see the export skill): confirm scope (element vs page), animated vs static, and which props to expose. Returns an artifact envelope.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        route: { type: "string" },
        selector: { type: "string", description: "CSS selector. For scope='page' select the page's root wrapper element." },
        name: { type: "string", description: "Semantic basename, no extension. Default 'graphic'." },
        scope: {
          type: "string",
          enum: ["element", "page"],
          description: "'element' (default) — overlay/asset: transparent frame, CSS shadow-scoped, sized to the element. 'page' — whole page: keeps the page background, sized to the captured root.",
        },
        animated: {
          type: "boolean",
          description: "true (default) — CSS animations stay seekable so they play as Resolve scrubs the timeline. false — frozen at the resting state (entrance complete).",
        },
        props: {
          type: "array",
          description: "Editable fields shown in Resolve's OGraf inspector. Propose these by inspecting the design, then confirm with the user via ask_user. Empty = baked graphic, nothing editable.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Identifier / schema property name (e.g. 'title')." },
              label: { type: "string", description: "Human label shown in the inspector." },
              type: { type: "string", enum: ["text", "number", "color"], description: "Value type — drives the inspector control." },
              control: {
                type: "string",
                enum: ["text", "background", "color", "fontSize", "fontFamily", "opacity", "duration"],
                description: "What the value changes: text→element textContent; background/color→a CSS colour; fontSize→font size in px (use type 'number'); fontFamily→font name (type 'text'); opacity→whole-graphic opacity; duration→animation length in seconds (type 'number').",
              },
              target: { type: "string", description: "CSS selector within the captured subtree the control acts on. Required for text/background/color/duration; ignored for opacity." },
              default: { description: "Default value (string or number)." },
            },
            required: ["key", "label", "type", "control"],
          },
        },
      },
      required: ["projectId", "route", "selector"],
    },
    method: "POST",
    endpoint: "/api/export-ograf",
    returns: ARTIFACT_RETURN,
    category: "export",
  },
];

/** Lookup helper. Returns null if no capability matches the id. */
export function findCapability(id: string): Capability | null {
  return CAPABILITIES.find((c) => c.id === id) ?? null;
}

/** Adapter-friendly serialization. Identical to the in-memory shape but
 *  expressed as a plain JSON-safe value (no functions, no dates) so
 *  adapters reading via /api/capabilities get a stable wire format. */
export function serializeCapabilities(): { capabilities: Capability[] } {
  return { capabilities: CAPABILITIES };
}
