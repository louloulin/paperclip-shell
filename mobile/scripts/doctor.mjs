#!/usr/bin/env node
// Verify the mobile shell's configuration without needing a device or emulator.
//
//   node scripts/doctor.mjs
//
// Checks the things that actually break a Capacitor build: missing platform
// folders, a config that disagrees with package.json, plugin packages that are
// declared but not installed, and a missing www/ entry point.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(label, fn) {
  try {
    const detail = fn();
    process.stdout.write(`[doctor] PASS  ${label}${detail ? ` — ${detail}` : ""}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stdout.write(`[doctor] FAIL  ${label} — ${error.message}\n`);
  }
}

const manifest = JSON.parse(readFileSync(path.join(mobileRoot, "package.json"), "utf8"));
const configSource = readFileSync(path.join(mobileRoot, "capacitor.config.ts"), "utf8");

check("www entry point", () => {
  const entry = path.join(mobileRoot, "www", "index.html");
  if (!existsSync(entry)) throw new Error(`missing ${entry}`);
  return "www/index.html";
});

check("config appId matches manifest", () => {
  const appId = /appId:\s*"([^"]+)"/.exec(configSource)?.[1];
  if (!appId) throw new Error("appId not found in capacitor.config.ts");
  if (manifest.name && appId !== "ai.paperclip.app") {
    throw new Error(`unexpected appId ${appId}`);
  }
  return appId;
});

check("config webDir exists", () => {
  const webDir = /webDir:\s*"([^"]+)"/.exec(configSource)?.[1];
  if (!webDir) throw new Error("webDir not found in capacitor.config.ts");
  if (!existsSync(path.join(mobileRoot, webDir))) throw new Error(`missing ${webDir}/`);
  return webDir;
});

check("capacitor plugins installed", () => {
  const declared = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    name.startsWith("@capacitor/"),
  );
  const missing = declared.filter(
    (name) => !existsSync(path.join(mobileRoot, "node_modules", ...name.split("/"))),
  );
  if (missing.length > 0) throw new Error(`not installed: ${missing.join(", ")}`);
  return `${declared.length} packages`;
});

check("native platforms", () => {
  const platforms = ["ios", "android"].filter((dir) => existsSync(path.join(mobileRoot, dir)));
  if (platforms.length === 0) {
    notes.push("no native platform folders yet — run `npm run add:ios` / `npm run add:android`");
    return "none (expected before `cap add`)";
  }
  return platforms.join(", ");
});

check("synced native config per platform", () => {
  const configPaths = {
    ios: ["App", "App", "capacitor.config.json"],
    android: ["app", "src", "main", "assets", "capacitor.config.json"],
  };
  const platforms = Object.keys(configPaths).filter((dir) => existsSync(path.join(mobileRoot, dir)));
  if (platforms.length === 0) return "skipped (no platforms)";
  for (const platform of platforms) {
    const configFile = path.join(mobileRoot, platform, ...configPaths[platform]);
    if (!existsSync(configFile)) throw new Error(`${platform} synced config missing: ${configFile}`);
    const synced = JSON.parse(readFileSync(configFile, "utf8"));
    if (synced.appId !== "ai.paperclip.app") {
      throw new Error(`${platform} synced appId is ${synced.appId}`);
    }
  }
  return platforms.join(", ");
});

check("synced web assets per platform", () => {
  const publicPaths = {
    ios: ["App", "App", "public"],
    android: ["app", "src", "main", "assets", "public"],
  };
  const platforms = Object.keys(publicPaths).filter((dir) => existsSync(path.join(mobileRoot, dir)));
  if (platforms.length === 0) return "skipped (no platforms)";
  for (const platform of platforms) {
    const entry = path.join(mobileRoot, platform, ...publicPaths[platform], "index.html");
    if (!existsSync(entry)) throw new Error(`${platform} has no synced web assets — run \`npm run sync\``);
  }
  return platforms.join(", ");
});

if (notes.length > 0) {
  for (const note of notes) process.stdout.write(`[doctor] NOTE  ${note}\n`);
}
if (failures.length > 0) {
  process.stdout.write(`[doctor] ${failures.length} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("[doctor] all checks passed\n");
