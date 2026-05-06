/* notifications.ts — turn-complete + render-complete pings.
 *
 * Two channels:
 *   - sound: oscillator-synthesized via WebAudio — no audio assets to ship.
 *     Distinct timbre for success vs failure so a tabbed-away user can tell
 *     which kind of notification fired by ear.
 *   - desktop: browser Notification API. Click brings the originating tab
 *     back to the foreground (via the service worker registered in main.tsx).
 *
 * "Don't be annoying" rule: if `document.hasFocus()` returns true when
 * `notifyTurnComplete()` fires, both channels are no-ops — the user is
 * already looking at the page, no need to ping. Permission is requested
 * lazily on first toggle, never proactively at app boot.
 *
 * Settings → Notifications (in SettingsDialog) drives the prefs object.
 * Inspired by nexu-io/open-design's notifications module — see issue #5. */

const PREFS_KEY = "editor.notifications";

export type SuccessSoundId = "ding" | "chime" | "two-tone-up" | "pluck";
export type FailureSoundId = "buzz" | "two-tone-down" | "thud";

export const SUCCESS_SOUNDS: { id: SuccessSoundId; label: string }[] = [
  { id: "ding", label: "Ding" },
  { id: "chime", label: "Chime" },
  { id: "two-tone-up", label: "Two-tone up" },
  { id: "pluck", label: "Pluck" },
];

export const FAILURE_SOUNDS: { id: FailureSoundId; label: string }[] = [
  { id: "buzz", label: "Buzz" },
  { id: "two-tone-down", label: "Two-tone down" },
  { id: "thud", label: "Thud" },
];

export type NotifPrefs = {
  /** Master switch for the audible ping. */
  soundEnabled: boolean;
  successSoundId: SuccessSoundId;
  failureSoundId: FailureSoundId;
  /** Master switch for the desktop notification. Independent of sound —
   *  one user wants only sound (working with headphones), another only
   *  desktop pings (DJ booth where audio is reserved for the program). */
  desktopEnabled: boolean;
};

const DEFAULTS: NotifPrefs = {
  soundEnabled: false,
  successSoundId: "ding",
  failureSoundId: "buzz",
  desktopEnabled: false,
};

export function loadNotifPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveNotifPrefs(next: NotifPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch { /* localStorage may be blocked. */ }
}

// ─── Sound synthesis ───────────────────────────────────────────

/** Lazy AudioContext — creating on every play is wasteful and many
 *  browsers cap concurrent contexts. Reused across the page lifetime. */
let _ctx: AudioContext | null = null;
function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!_ctx) _ctx = new Ctor();
  return _ctx;
}

/** Drop a single tone with an exp-decay envelope. Building block for the
 *  composite sounds below. */
function tone(
  c: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  type: OscillatorType = "sine",
  peakGain = 0.25,
) {
  const t0 = c.currentTime + startOffset;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peakGain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playSuccess(id: SuccessSoundId): void {
  const c = ctx();
  if (!c) return;
  // Resume in case the context started suspended (autoplay policy).
  if (c.state === "suspended") c.resume().catch(() => {});
  switch (id) {
    case "ding":
      tone(c, 880, 0, 0.40, "sine", 0.30);
      break;
    case "chime":
      tone(c, 660, 0,    0.50, "sine", 0.22);
      tone(c, 880, 0.08, 0.50, "sine", 0.22);
      tone(c, 1320, 0.16, 0.50, "sine", 0.18);
      break;
    case "two-tone-up":
      tone(c, 660, 0,    0.20, "triangle", 0.28);
      tone(c, 990, 0.18, 0.30, "triangle", 0.28);
      break;
    case "pluck":
      tone(c, 1200, 0, 0.15, "triangle", 0.32);
      tone(c, 600, 0.04, 0.20, "sine", 0.18);
      break;
  }
}

export function playFailure(id: FailureSoundId): void {
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  switch (id) {
    case "buzz":
      tone(c, 220, 0, 0.30, "sawtooth", 0.20);
      break;
    case "two-tone-down":
      tone(c, 660, 0,    0.20, "triangle", 0.26);
      tone(c, 440, 0.18, 0.30, "triangle", 0.26);
      break;
    case "thud":
      tone(c, 110, 0, 0.20, "sine", 0.32);
      break;
  }
}

// ─── Desktop notification ──────────────────────────────────────

/** Cached so SettingsDialog can show "Active / Off / Denied" without
 *  asking permission. */
export function currentPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

type CompletionPayload = {
  /** "success" → success sound + green-themed icon; "failure" → buzz +
   *  red icon. UI strings come from the caller. */
  status: "success" | "failure";
  title: string;
  body: string;
  /** Free-form tag to dedupe notifications — passing the same tag will
   *  replace the prior one rather than stacking. */
  tag?: string;
};

async function showDesktopNotification(p: CompletionPayload): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  // Prefer the service-worker path so the notification survives tab close
  // and the click handler can focus the originating tab. Fall back to the
  // direct Notification ctor when the SW isn't registered yet.
  try {
    const reg = typeof navigator !== "undefined" ? await navigator.serviceWorker?.getRegistration?.() : null;
    if (reg) {
      await reg.showNotification(p.title, {
        body: p.body,
        tag: p.tag,
        icon: "/favicon.ico",
        data: { url: typeof location !== "undefined" ? location.href : undefined },
      });
      return;
    }
  } catch { /* fall through to direct ctor */ }
  new Notification(p.title, { body: p.body, tag: p.tag, icon: "/favicon.ico" });
}

/** Top-level "turn finished" hook. Consumes prefs, applies the focus
 *  guard, plays/shows as configured. Safe to call from any event handler. */
export function notifyTurnComplete(p: CompletionPayload): void {
  // Don't ping when the user is already looking at us.
  if (typeof document !== "undefined" && document.hasFocus && document.hasFocus()) return;
  const prefs = loadNotifPrefs();
  if (prefs.soundEnabled) {
    if (p.status === "success") playSuccess(prefs.successSoundId);
    else playFailure(prefs.failureSoundId);
  }
  if (prefs.desktopEnabled) void showDesktopNotification(p);
}

/** Settings → Notifications "Send test" button. Bypasses the focus guard
 *  so the user can preview behavior with the dialog open. */
export async function sendTestNotification(): Promise<void> {
  const prefs = loadNotifPrefs();
  if (prefs.soundEnabled) playSuccess(prefs.successSoundId);
  if (prefs.desktopEnabled) {
    if (currentPermission() === "default") {
      const r = await requestNotificationPermission();
      if (r !== "granted") return;
    }
    await showDesktopNotification({
      status: "success",
      title: "Notification preview",
      body: "This is what an agent-completion ping will look like.",
      tag: "aiatelie-test",
    });
  }
}

/** Register the SW once on app boot. Idempotent — repeated calls are no-ops.
 *  Failure is non-fatal: notifications still work via the direct ctor path,
 *  they just don't survive tab close or focus the right window on click. */
export async function registerNotificationServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  try {
    await navigator.serviceWorker.register("/aiatelie-notifications-sw.js");
  } catch { /* offline/dev/blocked — the direct-ctor fallback still works. */ }
}
