import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

// 2-second smoke composition. Used by `bunx remotion render --output ...`
// to verify Remotion + headless Chrome + ffmpeg all link up correctly
// on a fresh checkout. Not shown to end users.
export const HelloWorld: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <h1
        style={{
          color: "white",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
          fontSize: 64,
          fontWeight: 700,
          opacity,
          margin: 0,
        }}
      >
        AI Atelie
      </h1>
    </AbsoluteFill>
  );
};
