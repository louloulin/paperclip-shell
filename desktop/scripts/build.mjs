#!/usr/bin/env node
// Bundle the Electron main process and preload script with esbuild.

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { desktopRoot, log, run } from "./lib.mjs";

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

// Shell-owned pages, for scripts/preview-shell.cjs. Bundling them separately
// keeps the preview harness free of the server/runtime wiring.
await build({
  entryPoints: {
    "preview-exports": path.join(desktopRoot, "src", "preview-exports.ts"),
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["electron"],
  logLevel: "warning",
});

// The server bootstrap must be CommonJS: it runs under Electron's Node, where
// a CJS entry is the most reliable form.
await build({
  entryPoints: { "server-bootstrap": path.join(desktopRoot, "src", "server-bootstrap.ts") },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  logLevel: "warning",
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

// --- plugins: stage the installable catalog into resources/plugins ----------
//
// The Chinese language pack lives in its own repository and is consumed as a
// read-only build input (same rule as the Paperclip checkout): this script
// builds it and stages the runtime files plus a shell-owned plugin.json.

const pluginsOutDir = path.join(desktopRoot, "resources", "plugins");
mkdirSync(pluginsOutDir, { recursive: true });

function resolveZhPackRoot() {
  const fromEnv = process.env.PAPERCLIP_ZH_PACK?.trim();
  const candidate = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(desktopRoot, "..", "..", "paperclip-zh-pack");
  return existsSync(path.join(candidate, "package.json")) ? candidate : null;
}

const zhPackRoot = resolveZhPackRoot();
if (!zhPackRoot) {
  log(
    STEP,
    "plugins: paperclip-zh-pack not found (set PAPERCLIP_ZH_PACK=<repo>) — plugin catalog stays empty",
  );
} else {
  const pluginOut = path.join(pluginsOutDir, "paperclip-zh-pack");
  if (process.env.PAPERCLIP_SHELL_SKIP_PLUGIN_BUILD !== "1") {
    run(process.execPath, [path.join(zhPackRoot, "scripts", "build.mjs")], { cwd: zhPackRoot });
  }
  for (const file of ["dist/page-patch.js", "dist/content-script.js"]) {
    if (!existsSync(path.join(zhPackRoot, file))) {
      throw new Error(`paperclip-zh-pack is missing ${file} (build it first or unset PAPERCLIP_SHELL_SKIP_PLUGIN_BUILD)`);
    }
  }
  const pkg = JSON.parse(readFileSync(path.join(zhPackRoot, "package.json"), "utf8"));
  rmSync(pluginOut, { recursive: true, force: true });
  mkdirSync(pluginOut, { recursive: true });
  for (const file of ["dist/page-patch.js", "dist/content-script.js"]) {
    copyFileSync(path.join(zhPackRoot, file), path.join(pluginOut, path.basename(file)));
  }
  const manifest = {
    id: "paperclip-zh-pack",
    name: "Paperclip 中文语言包",
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    description: "界面与接口消息汉化（词典精确替换，未命中回退原文）",
    // Order mirrors the pack's own injection: the fetch patch installs first,
    // then the DOM translator.
    scripts: ["page-patch.js", "content-script.js"],
    matchOrigins: ["http://127.0.0.1", "http://localhost"],
  };
  writeFileSync(path.join(pluginOut, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(STEP, `plugins: staged paperclip-zh-pack@${manifest.version} -> ${pluginOut}`);
}
