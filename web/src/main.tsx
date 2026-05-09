import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from "react-router-dom";
import "./index.css";
// Side-effect import: applies the persisted theme attr on <html> before
// React mounts, so the first paint matches the user's choice.
import "./lib/theme";

// Dev-only: silence the benign "ResizeObserver loop completed with
// undelivered notifications" warning that browsers emit when a resize
// callback triggers another layout. Vite's HMR overlay promotes it to
// "Unhandled error" and floods the console, hiding real failures.
// Capture phase + stopImmediatePropagation runs before Vite's bubble-
// phase listener; preventDefault keeps it out of the browser console.
// Substring match leaves every other error untouched, so the overlay
// still surfaces real bugs. Tree-shaken from prod by import.meta.env.DEV.
if (import.meta.env.DEV) {
  window.addEventListener("error", (e) => {
    if (e.message && e.message.includes("ResizeObserver loop")) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}

import Editor from "./routes/Editor";
import Projects from "./routes/Projects";
import { hydrateProjectFromServer } from "./lib/projects";
import { registerNotificationServiceWorker } from "./lib/notifications";
import { ToastRegion } from "./components/toast";

// Register the notifications SW so completion pings persist past tab close
// and click handlers can refocus the originating tab. Failure is non-fatal.
void registerNotificationServiceWorker();

// The editor is the entire SPA now. User project content (banners,
// pages, components) lives under web/projects/<id>/ and is served
// raw by the projects middleware at /p/:id/*. The old SPA routes
// (Home, Slot, Titling, Inspirations) moved to _legacy/ at repo
// root for reference — they're no longer routable from the editor.
//
// /projects/:id/start used to mount a separate Onboard "wizard". The
// editor now renders an empty-project chat layout when no real files
// exist yet, so the wizard is redundant. We keep the route as a
// redirect so old links/bookmarks still land somewhere sensible.
function StartRedirect() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    if (!projectId) {
      navigate("/projects", { replace: true });
      return;
    }
    void hydrateProjectFromServer(projectId).then((p) => {
      navigate(p ? "/editor?fresh=1" : "/projects", { replace: true });
    });
  }, [projectId, navigate]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId/start" element={<StartRedirect />} />
        <Route path="/editor" element={<Editor />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
      <ToastRegion />
    </BrowserRouter>
  </StrictMode>
);
