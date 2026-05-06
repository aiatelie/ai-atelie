/* aiatelie-notifications-sw.js — minimal service worker for completion pings.
 *
 * Two reasons it exists:
 *   1. registration.showNotification persists past tab close; the direct
 *      `new Notification(...)` ctor doesn't survive a navigation.
 *   2. We can intercept the click event and focus the original tab (or
 *      open it if closed). Without an SW the click is a no-op except for
 *      dismissal.
 *
 * Kept under 30 lines on purpose — anything heavier should land in its own
 * SW so this one stays trivial to audit.
 */

self.addEventListener("install", () => {
  // Skip waiting so the first registration becomes active without a tab close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of any pages that loaded before the SW registered.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Try to surface a tab that already has the editor open.
    for (const c of all) {
      try {
        if (targetUrl && c.url === targetUrl && "focus" in c) {
          return c.focus();
        }
      } catch { /* ignore — fall through to the first match */ }
    }
    if (all.length > 0 && "focus" in all[0]) return all[0].focus();
    if (targetUrl && self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
