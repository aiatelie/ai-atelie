// Dev-time probe used by the verify-with-playwright evidence spec for
// issue #43 Phase D. Renders <Markdown> with a fixture so a Playwright
// run can assert on the resulting DOM in a real browser. Not imported
// anywhere in the app — only loaded dynamically by the e2e spec.

import { createRoot } from "react-dom/client";
import { Markdown } from "./Markdown";

export function mountProbe(into: HTMLElement, text: string) {
  createRoot(into).render(<Markdown text={text} />);
}
