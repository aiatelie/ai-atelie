import { Config } from "@remotion/cli/config";

// Demo-clip Remotion config. Project-relative paths so the skill works
// regardless of which directory the user invokes `bunx remotion` from
// (we always invoke from this folder via `cd tools/demo-clip`).
Config.setVideoImageFormat("jpeg");
Config.setEntryPoint("./src/index.ts");
Config.setConcurrency(1);
