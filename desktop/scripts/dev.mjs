#!/usr/bin/env node
// Build the shell and launch it against the staged server.
//
//   node scripts/dev.mjs                 # normal window
//   PAPERCLIP_DESKTOP_SMOKE=1 node ...   # boot, assert the UI mounted, exit

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { desktopRoot, log, resolveElectronBinary, stageServerEntry } from "./lib.mjs";
import { run } from "./lib.mjs";

const STEP = "dev";

if (!existsSync(stageServerEntry)) {
  throw new Error(`staged server missing (${stageServerEntry}); run \`npm run stage\` first`);
}

run(process.execPath, [path.join(desktopRoot, "scripts", "build.mjs")]);

const electron = resolveElectronBinary();
log(STEP, `launching ${electron}${process.env.PAPERCLIP_DESKTOP_SMOKE === "1" ? " (smoke)" : ""}`);

const child = spawn(electron, [desktopRoot], {
  stdio: "inherit",
  env: { ...process.env },
});
child.on("exit", (code) => process.exit(code ?? 1));
