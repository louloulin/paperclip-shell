#!/usr/bin/env node
// Bundle the Electron main process and preload script with esbuild.

import { build } from "esbuild";
import path from "node:path";
import { desktopRoot, log } from "./lib.mjs";

const STEP = "build";
const outdir = path.join(desktopRoot, "dist");

const result = await build({
  entryPoints: {
    main: path.join(desktopRoot, "src", "main.ts"),
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["electron"],
  // electron-updater (and the fs-extra chain behind it) is CommonJS and uses
  // dynamic require("fs"). Bundling it into an ESM file therefore needs a real
  // `require` binding in scope, which the banner provides.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
  metafile: true,
});

// The preload script must be CommonJS: Electron loads preload scripts as CJS.
await build({
  entryPoints: { preload: path.join(desktopRoot, "src", "preload.ts") },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  logLevel: "warning",
});

log(STEP, `bundled ${Object.keys(result.metafile.inputs).length} inputs -> ${outdir}`);
