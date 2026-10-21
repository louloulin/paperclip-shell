#!/usr/bin/env node
// Package the desktop app with electron-builder.
//
//   node scripts/package.mjs --mac              # dmg (arm64 + x64)
//   node scripts/package.mjs --mac --dir        # unpacked .app only (fast, smoke-testable)
//   node scripts/package.mjs --mac --dir --arm64
//   node scripts/package.mjs --win|--linux
//
// Two-phase on purpose: electron-builder hardcodes `!**/node_modules/**` in its
// default ignore list, which silently strips the staged server's runtime closure
// from extraResources. So we build the unpacked app first, copy the server tree
// ourselves (preserving the postgres dylib alias symlinks), then build the
// installer from the prepackaged app.
//
// Packaging is per-platform: sharp, @embedded-postgres/<platform> and the agent
// runtime packages are platform-specific binaries and cannot be cross-built.

import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { capture, desktopRoot, log, resolveElectronBinary, run, stageDirFor, stageServerEntry } from "./lib.mjs";

const STEP = "package";
const args = process.argv.slice(2);
const targets = ["--mac", "--win", "--linux"].filter((flag) => args.includes(flag));
const dirOnly = args.includes("--dir");
const requestedArches = ["--arm64", "--x64", "--universal"].filter((flag) => args.includes(flag));
const arches = requestedArches.length > 0 ? requestedArches : [`--${process.arch === "x64" ? "x64" : "arm64"}`];

if (targets.length === 0) {
  throw new Error("usage: package.mjs --mac|--win|--linux [--dir] [--arm64|--x64]");
}
if (targets.includes("--mac") && process.platform !== "darwin") {
  throw new Error("macOS targets must be built on macOS (platform binaries cannot be cross-built)");
}
if (targets.includes("--win") && process.platform !== "win32") {
  log(STEP, "WARNING: building a Windows target off-Windows; native deps will not match");
}
if (arches.includes("--universal")) {
  throw new Error(
    "universal builds are unsupported: the staged server contains per-arch native binaries (sharp, embedded-postgres). Build --arm64 and --x64 separately.",
  );
}
// The staged server tree is arch-specific (sharp, @embedded-postgres/<platform>,
// agent runtimes), so each architecture consumes its own stage dir. The native
// arch lives in .stage/server; other arches in .stage/server-<arch>.
const stageDirs = new Map();
for (const arch of arches) {
  const archName = arch.replace(/^--/, "");
  const dir = stageDirFor(archName);
  if (!existsSync(path.join(dir, "dist", "index.js"))) {
    throw new Error(
      `staged server for ${archName} missing (${path.join(dir, "dist", "index.js")}); run:\n` +
        `  PAPERCLIP_SHELL_TARGET_ARCH=${archName} npm run stage`,
    );
  }
  stageDirs.set(arch, dir);
}
if (!existsSync(stageServerEntry)) {
  log(STEP, `note: native-arch stage missing (${stageServerEntry}); only ${arches.join(", ")} will be packaged`);
}

const releaseDir = path.join(desktopRoot, "release");
const electronBuilder = path.join(desktopRoot, "node_modules", ".bin", "electron-builder");
if (!existsSync(electronBuilder)) {
  throw new Error("electron-builder is not installed. Run `npm install` in desktop/ first.");
}
const builderEnv = {
  ...process.env,
  // Unsigned local builds by default; CI provides CSC_LINK / CSC_IDENTITY_AUTO_DISCOVERY.
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
};

// 1. Bundle the shell.
run(process.execPath, [path.join(desktopRoot, "scripts", "build.mjs")]);
log(STEP, `electron: ${resolveElectronBinary()}`);

// 2-4. Per architecture: build the unpacked app, drop in the staged server,
// then build the installer from that exact bundle.
const processed = new Set();
for (const arch of arches) {
  const archName = arch.replace(/^--/, "");
  const archStageDir = stageDirs.get(arch);
  // Gate the exact tree this arch will ship (see preflight-runtime.mjs).
  run(process.execPath, [path.join(desktopRoot, "scripts", "preflight-runtime.mjs")], {
    env: { ...process.env, PAPERCLIP_SHELL_TARGET_ARCH: archName },
  });
  log(STEP, `building unpacked app (${targets.join(" ")} ${arch}) ...`);
  const buildStartedAt = Date.now();
  run(electronBuilder, [...targets, arch, "--dir"], { cwd: desktopRoot, env: builderEnv });

  // release/ accumulates one app dir per arch (mac, mac-arm64, ...). Only touch
  // bundles this build just produced, or a stale other-arch app would get this
  // arch's server tree injected into it.
  for (const bundle of findAppBundles(releaseDir)) {
    if (processed.has(bundle)) continue;
    if (statSync(bundle).mtimeMs < buildStartedAt - 2000) {
      log(STEP, `skipping stale bundle from an earlier build: ${path.relative(releaseDir, bundle)}`);
      continue;
    }
    processed.add(bundle);
    bundleServer(bundle, archStageDir, archName);

    if (!dirOnly) {
      log(STEP, `building installer from ${path.basename(bundle)} ...`);
      run(electronBuilder, [...targets, arch, "--prepackaged", bundle], {
        cwd: desktopRoot,
        env: builderEnv,
      });
    }
  }
}

function findAppBundles(dir, depth = 0) {
  const found = [];
  if (depth > 2) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith(".app") || entry.name.endsWith("-unpacked")) found.push(full);
    else found.push(...findAppBundles(full, depth + 1));
  }
  return found;
}

function bundleServer(bundle, sourceDir, archName) {
  const destination = path.join(
    bundle.endsWith(".app") ? path.join(bundle, "Contents", "Resources") : path.join(bundle, "resources"),
    "server",
  );
  rmSync(destination, { recursive: true, force: true });
  // `ditto` on macOS preserves symlinks, permissions and extended attributes;
  // cp -R elsewhere. (The postgres dylib aliases are symlinks.)
  if (process.platform === "darwin") run("ditto", [sourceDir, destination]);
  else cpSync(sourceDir, destination, { recursive: true, dereference: false });

  const checks = [
    path.join(destination, "dist", "index.js"),
    path.join(destination, "ui-dist", "index.html"),
    path.join(destination, "node_modules", "express"),
    path.join(destination, "node_modules", "embedded-postgres"),
  ];
  for (const file of checks) {
    if (!existsSync(file)) throw new Error(`bundled server is incomplete: missing ${file}`);
  }
  // Assert the staged tree matches the arch being packaged, not the host.
  const postgresDir = path.join(
    destination,
    "node_modules",
    "@embedded-postgres",
    `${process.platform}-${archName}`,
  );
  if (!existsSync(path.join(postgresDir, "native", "bin", "initdb"))) {
    throw new Error(
      `bundled server is missing the ${archName} platform postgres binaries (${postgresDir}); ` +
        `was it staged with PAPERCLIP_SHELL_TARGET_ARCH=${archName}?`,
    );
  }
  const sharpDir = path.join(destination, "node_modules", "@img", `sharp-${process.platform}-${archName}`);
  if (!existsSync(sharpDir)) {
    throw new Error(`bundled server is missing the ${archName} sharp binary (${sharpDir})`);
  }
  const symlinks = countSymlinks(postgresDir);
  if (symlinks === 0) {
    throw new Error("postgres dylib alias symlinks were lost while copying the server tree");
  }
  log(STEP, `${path.basename(bundle)} [${archName}]: server bundled (${symlinks} symlinks preserved)`);
}

function countSymlinks(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) count += 1;
    else if (entry.isDirectory() && statSync(full).isDirectory()) count += countSymlinks(full);
  }
  return count;
}

log(STEP, `artifacts in ${releaseDir}:`);
for (const entry of capture("ls", ["-1", releaseDir]).split("\n").filter(Boolean)) {
  log(STEP, `  ${entry}`);
}
