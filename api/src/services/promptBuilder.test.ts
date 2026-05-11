/* promptBuilder.test.ts — focused coverage for the new chip-preamble
 * rendering. The full prompt builder integrates with the filesystem
 * (screenshot save, project dir lookup) so the broader suite would be
 * heavy; we just verify the section appears where it should and is
 * omitted when no chips are active.
 *
 * Driven via the legacy path (no projectId) since that path doesn't
 * touch any project files for prompt construction.
 */

import { describe, expect, it } from "bun:test";
import { preparePromptForPayload } from "./promptBuilder.ts";

const baseLegacyPayload = {
  route: "/editor",
  selector: "h1",
  tag: "h1",
  comment: "make the headline louder",
};

describe("chipPreamble in prompt builder", () => {
  it("renders a 'Composer posture for this turn' section when chipPreamble is set", async () => {
    const { prompt } = await preparePromptForPayload({
      ...baseLegacyPayload,
      chipPreamble: "[Active skills: wireframe]\n### Wireframe\nSketchy low-fi.",
    });
    expect(prompt).toContain("## Composer posture for this turn");
    expect(prompt).toContain("### Wireframe");
    expect(prompt).toContain("Sketchy low-fi.");
  });

  it("places the posture section ABOVE the user's comment block", async () => {
    const { prompt } = await preparePromptForPayload({
      ...baseLegacyPayload,
      chipPreamble: "[Active skills: hifi]\n### High fidelity\nPolished.",
    });
    const postureIdx = prompt.indexOf("Composer posture for this turn");
    const commentIdx = prompt.indexOf("**User's comment:**");
    expect(postureIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeGreaterThan(postureIdx);
  });

  it("omits the posture section entirely when chipPreamble is absent", async () => {
    const { prompt } = await preparePromptForPayload(baseLegacyPayload);
    expect(prompt).not.toContain("Composer posture for this turn");
  });

  it("does NOT smuggle the chip preamble into the user's comment block", async () => {
    // The whole point of the split: the user's blockquoted `> comment`
    // line stays literally the user's text, not a Markdown soup of
    // skill headers. Verify by extracting the blockquote line.
    const { prompt } = await preparePromptForPayload({
      ...baseLegacyPayload,
      chipPreamble: "[Active skills: wireframe]\n### Wireframe\nSketchy.",
    });
    const blockquoteMatch = prompt.match(/^> .*$/m);
    expect(blockquoteMatch).toBeTruthy();
    expect(blockquoteMatch![0]).toBe("> make the headline louder");
  });
});
