import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from "react-router-dom";
import "./index.css";
// Side-effect import: applies the persisted theme attr on <html> before
// React mounts, so the first paint matches the user's choice.
import "./lib/theme";
import Editor from "./routes/Editor";
import Projects from "./routes/Projects";
import { hydrateProjectFromServer } from "./lib/projects";

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
    </BrowserRouter>
  </StrictMode>
);
