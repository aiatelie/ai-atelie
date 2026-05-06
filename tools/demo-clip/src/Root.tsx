import React from "react";
import { Composition } from "remotion";
import { HelloWorld } from "./HelloWorld";

// Minimal Remotion root used by the `demo-clip` skill's sanity check.
// Real demo compositions are added by the user (see ../README docs in
// the .claude/skills/demo-clip/SKILL.md). This `HelloWorld` exists
// only so `bunx remotion render` can prove the toolchain works end to
// end on a fresh clone.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={60}
        fps={30}
        width={640}
        height={360}
      />
    </>
  );
};
