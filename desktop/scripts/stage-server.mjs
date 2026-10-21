#!/usr/bin/env node
// Stage a self-contained, runnable Paperclip server tree into desktop/.stage/server.
//
// The Paperclip checkout is only ever *read* (its own build outputs under
// dist/ are gitignored artifacts produced by its own scripts).
//
// Steps:
//   1. build @paperclipai/ui and @paperclipai/server with the repo's own scripts
//   2. pack every workspace package the server depends on (`pnpm pack`)
//   3. write a stage manifest that points @paperclipai/* at those tarballs and
//      npm install the runtime closure (--omit=dev) into the stage dir
//   4. re-apply the repository's dependency patches (acpx + ACP bridges) with the
//      repo's own release helper, then verify the patch markers
//
// Why not `pnpm deploy`: this pnpm (9.15.4) validates every patchedDependencies
// entry against the *filtered* deploy graph and hard-fails on the repo's stale
// `acpx@0.12.0` entry (only 0.13.1 is in the graph). Why not registry-only npm
// install: three workspace packages (adapter-kimi-local, hermes adapter,
// plugin-sdk) are not published at this version, and mixing published 0.3.1
// workspace packages with this checkout's server build risks drift.
//
// Env:
//   PAPERCLIP_REPO=...            Paperclip checkout (default: ../paperclip)
//   PAPERCLIP_SHELL_SKIP_BUILD=1  reuse existing ui/dist + server/dist outputs
//   PAPERCLIP_SHELL_SKIP_UI=1     reuse existing ui/dist (still builds the server)
//   PAPERCLIP_SHELL_SKIP_PACK=1   reuse existing .stage/tarballs

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { capture, log, resolvePaperclipRepo, run, stageDir } from "./lib.mjs";

const STEP = "stage";
const repo = resolvePaperclipRepo();
const tarballDir = path.join(stageDir, "..", "tarballs");
const skipBuild = process.env.PAPERCLIP_SHELL_SKIP_BUILD === "1";
const skipUi = skipBuild || process.env.PAPERCLIP_SHELL_SKIP_UI === "1";
const skipPack = process.env.PAPERCLIP_SHELL_SKIP_PACK === "1";

function requireFile(file, hint) {
  if (!existsSync(file)) throw new Error(`missing ${file}${hint ? ` (${hint})` : ""}`);
}

log(STEP, `paperclip repo: ${repo}`);

// The workspace's own binaries must win over any global install of vite/tsc.
// (In this environment pnpm's script PATH does not always include the
// workspace .bin dirs, which silently picked up a global `vite`.)
const buildEnv = {
  ...process.env,
  PATH: [
    path.join(repo, "node_modules", ".bin"),
    path.join(repo, "ui", "node_modules", ".bin"),
    path.join(repo, "server", "node_modules", ".bin"),
    process.env.PATH ?? "",
  ].join(path.delimiter),
};

// --- 1. Build the UI and the server ---------------------------------------
if (skipUi && existsSync(path.join(repo, "ui", "dist", "index.html"))) {
  log(STEP, "ui build skipped (reusing ui/dist)");
} else {
  log(STEP, "building @paperclipai/ui ...");
  run("pnpm", ["--dir", repo, "--filter", "@paperclipai/ui", "build"], { env: buildEnv });
}
requireFile(path.join(repo, "ui", "dist", "index.html"), "run the ui build first");

if (skipBuild && existsSync(path.join(repo, "server", "dist", "index.js"))) {
  log(STEP, "server build skipped (reusing server/dist)");
} else {
  log(STEP, "building @paperclipai/server ...");
  run("pnpm", ["--dir", repo, "--filter", "@paperclipai/server", "build"], { env: buildEnv });
}
requireFile(path.join(repo, "server", "dist", "index.js"), "run the server build first");

// --- 2. Locate and pack the workspace closure -----------------------------
const sourceManifest = JSON.parse(readFileSync(path.join(repo, "server", "package.json"), "utf8"));
const workspacePackages = indexWorkspacePackages(repo);

function indexWorkspacePackages(root) {
  const roots = [
    path.join(root, "server"),
    path.join(root, "ui"),
    path.join(root, "cli"),
    path.join(root, "packages"),
    path.join(root, "packages", "adapters"),
    path.join(root, "packages", "plugins"),
  ];
  const index = new Map();
  const visit = (dir, depth) => {
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name && !index.has(manifest.name)) index.set(manifest.name, dir);
      } catch {
        // Ignore unreadable manifests (e.g. fixtures).
      }
    }
    if (depth <= 0) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      visit(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const dir of roots) visit(dir, 1);
  return index;
}

const workspaceDeps = Object.keys(sourceManifest.dependencies ?? {})
  .concat(Object.keys(sourceManifest.optionalDependencies ?? {}))
  .filter((name) => name.startsWith("@paperclipai/"));
const missing = workspaceDeps.filter((name) => !workspacePackages.has(name));
if (missing.length > 0) {
  throw new Error(`workspace packages not found in checkout: ${missing.join(", ")}`);
}
log(STEP, `workspace closure: ${workspaceDeps.length} packages`);

rmSync(tarballDir, { recursive: true, force: true });
mkdirSync(tarballDir, { recursive: true });

const tarballs = new Map();
for (const name of workspaceDeps) {
  const dir = workspacePackages.get(name);
  const distDir = path.join(dir, "dist");
  if (!existsSync(distDir)) {
    throw new Error(`${name} has no dist/; build it in the checkout first (${dir})`);
  }
  if (skipPack) {
    const existing = readdirSync(tarballDir).find((file) => file.startsWith(`${name.replace("@", "").replace("/", "-")}-`));
    if (existing) {
      tarballs.set(name, path.join(tarballDir, existing));
      continue;
    }
  }
  run("pnpm", ["pack", "--pack-destination", tarballDir], { cwd: dir });
  const produced = readdirSync(tarballDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => path.join(tarballDir, file))
    .filter((file) => {
      const manifest = JSON.parse(capture("tar", ["-xzOf", file, "package/package.json"]));
      return manifest.name === name;
    });
  if (produced.length !== 1) {
    throw new Error(`expected exactly one tarball for ${name}, found ${produced.length}`);
  }
  tarballs.set(name, produced[0]);
}
log(STEP, `packed ${tarballs.size} workspace tarballs -> ${tarballDir}`);

// --- 3. Install the runtime closure ---------------------------------------
log(STEP, `staging into ${stageDir} ...`);
rmSync(stageDir, { recursive: true, force: true });
for (const entry of ["dist", "skills"]) {
  const source = path.join(repo, "server", entry);
  if (existsSync(source)) cpSync(source, path.join(stageDir, entry), { recursive: true });
}
cpSync(path.join(repo, "ui", "dist"), path.join(stageDir, "ui-dist"), { recursive: true });

const helperUrl = pathToFileURL(path.join(repo, "scripts", "prepare-bundled-package.mjs")).href;
const { materializePublishManifest } = await import(helperUrl);

const installManifest = materializePublishManifest(sourceManifest);
delete installManifest.devDependencies;
delete installManifest.scripts;
delete installManifest.bundleDependencies;
delete installManifest.files;
delete installManifest.publishConfig;
for (const name of workspaceDeps) {
  installManifest.dependencies[name] = `file:${tarballs.get(name)}`;
}

// embedded-postgres ships its platform binary as an optional dependency of the
// bundled copy inside @paperclipai/db; declare it at the top level so npm
// installs the binary for this machine (same trick the repo's release staging
// uses).
const embeddedPostgresManifest = path.join(
  repo,
  "packages",
  "db",
  "node_modules",
  "embedded-postgres",
  "package.json",
);
if (existsSync(embeddedPostgresManifest)) {
  const embedded = JSON.parse(readFileSync(embeddedPostgresManifest, "utf8"));
  installManifest.optionalDependencies = {
    ...(installManifest.optionalDependencies ?? {}),
    ...(embedded.optionalDependencies ?? {}),
  };
}
writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(installManifest, null, 2)}\n`);

log(STEP, "installing runtime closure (npm --omit=dev) ...");
// --legacy-peer-deps: npm 10's arborist crashes ("Cannot read properties of
// null (reading 'edgesOut')") in #loadPeerSet on this graph's peer sets.
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--legacy-peer-deps"], {
  cwd: stageDir,
});

// --- 4. Re-apply the repository's dependency patches ----------------------
const { applyBundledDependencyPatches } = await import(helperUrl);
const bundledDependencies =
  sourceManifest.bundleDependencies ?? sourceManifest.bundledDependencies ?? [];
log(STEP, `re-applying repository patches (${bundledDependencies.length} bundled packages) ...`);
applyBundledDependencyPatches(stageDir, bundledDependencies, repo);

// The repo helper only patches the server's *bundled* closure. `embedded-postgres`
// is a plain dependency of the server, so npm installs an unpatched copy at the
// top level (the patched one stays nested inside @paperclipai/db). Apply every
// remaining repository patch that matches a top-level package.
const rootPatchedDependencies =
  JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).pnpm?.patchedDependencies ?? {};
let extraPatches = 0;
for (const [selector, patchPath] of Object.entries(rootPatchedDependencies)) {
  const packageName = selector.slice(0, selector.lastIndexOf("@"));
  const packageDir = path.join(stageDir, "node_modules", ...packageName.split("/"));
  if (!existsSync(path.join(packageDir, "package.json"))) continue;
  const patchFile = path.join(repo, patchPath);
  if (!existsSync(patchFile)) continue;

  const dryRun = spawnSync(
    "patch",
    ["-p1", "--forward", "--dry-run", "-d", packageDir, "-i", patchFile],
    { encoding: "utf8" },
  );
  if (dryRun.status !== 0) continue; // already applied (or does not match) — leave as is

  run("patch", ["-p1", "--forward", "-d", packageDir, "-i", patchFile]);
  extraPatches += 1;
  log(STEP, `patched top-level ${selector}`);
}
log(STEP, `top-level patches applied: ${extraPatches}`);

// --- 4b. Hydrate the platform postgres package ----------------------------
// `@embedded-postgres/<platform>` creates the ICU/OpenSSL dylib aliases that
// its own binaries dlopen in a postinstall script (`hydrate-symlinks.js`).
// npm skips that lifecycle script for this optional dependency, and without the
// aliases `initdb` dies with "Library not loaded: libicudata.77.dylib".
const platformPostgresDir = path.join(
  stageDir,
  "node_modules",
  "@embedded-postgres",
  `${process.platform}-${process.arch}`,
);
const hydrateScript = path.join(platformPostgresDir, "scripts", "hydrate-symlinks.js");
if (existsSync(hydrateScript)) {
  run(process.execPath, ["scripts/hydrate-symlinks.js"], { cwd: platformPostgresDir });
  log(STEP, "hydrated platform postgres dylib aliases");
}
const initdb = path.join(platformPostgresDir, "native", "bin", "initdb");
if (!existsSync(initdb)) throw new Error(`initdb missing: ${initdb}`);
const initdbVersion = capture(initdb, ["--version"]);
log(STEP, `platform postgres: ${initdbVersion}`);

// --- 5. Verify the staged tree is actually runnable -----------------------
const checks = [
  [path.join(stageDir, "dist", "index.js"), "server entry"],
  [path.join(stageDir, "ui-dist", "index.html"), "SPA shell"],
  [path.join(stageDir, "node_modules", "express"), "express"],
  [path.join(stageDir, "node_modules", "sharp"), "sharp (native)"],
  [path.join(stageDir, "node_modules", "embedded-postgres"), "embedded-postgres"],
];
for (const [file, label] of checks) requireFile(file, label);
const platformPostgres = path.join(
  stageDir,
  "node_modules",
  "@embedded-postgres",
  `${process.platform}-${process.arch}`,
);
if (!existsSync(platformPostgres) || !statSync(platformPostgres).isDirectory()) {
  throw new Error(`platform postgres binaries missing: ${platformPostgres}`);
}

const embeddedIndex = path.join(stageDir, "node_modules", "embedded-postgres", "dist", "index.js");
if (!readFileSync(embeddedIndex, "utf8").includes("globalThis.process.env")) {
  throw new Error("embedded-postgres patch missing after staging");
}
log(STEP, "embedded-postgres patch: present");

const acpxManifest = JSON.parse(readFileSync(path.join(stageDir, "node_modules", "acpx", "package.json"), "utf8"));
const acpxMarker = { "0.12.0": "onAgentStderr", "0.13.1": "spawnEnvironment" }[acpxManifest.version];
if (!acpxMarker) throw new Error(`unexpected acpx version ${acpxManifest.version}`);
if (!readFileSync(path.join(stageDir, "node_modules", "acpx", "dist", "runtime.js"), "utf8").includes(acpxMarker)) {
  throw new Error(`acpx@${acpxManifest.version} runtime is missing the repository patch`);
}
log(STEP, `acpx@${acpxManifest.version} patch: present`);

log(STEP, `staged @paperclipai/server@${sourceManifest.version} -> ${stageDir}`);
log(STEP, `size before trim: ${capture("du", ["-sh", stageDir]).split("\t")[0]}`);

// --- 6. Trim source maps -------------------------------------------------
// Source maps are the largest single class of files that the runtime never
// reads. Set PAPERCLIP_SHELL_KEEP_MAPS=1 to keep them (useful when debugging
// the packaged server).
if (process.env.PAPERCLIP_SHELL_KEEP_MAPS !== "1") {
  let removed = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".map")) {
        rmSync(entryPath, { force: true });
        removed += 1;
      }
    }
  };
  walk(stageDir);
  log(STEP, `removed ${removed} source maps`);
}
log(STEP, `size: ${capture("du", ["-sh", stageDir]).split("\t")[0]}`);
