#!/usr/bin/env node
// Real verification of the desktop shell's M3/M4 features.
//
//   node scripts/verify-shell.mjs [--dev]
//
// The features under test (tray, About window, log export, update channel)
// live in the Electron main process, so the checks run inside the app:
// PAPERCLIP_DESKTOP_VERIFY=1 makes the shell execute them and exit with the
// failure count as its exit code.
//
// This script supplies the environment the checks need:
//
//   * a throwaway userData profile (a fresh Paperclip database, no pollution)
//   * a local HTTP server that serves a *newer* release as a generic
//     electron-updater feed, so "update available" is exercised for real
//     instead of being asserted by inspection
//
// `--dev` runs the checks in the unpackaged Electron binary, where the
// updater is intentionally disabled; the update check then reports
// "disabled" instead of "available".

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopRoot, log, resolveElectronBinary, run, stageServerEntry } from "./lib.mjs";

const STEP = "verify";
const args = process.argv.slice(2);
const useDev = args.includes("--dev");

if (!existsSync(stageServerEntry)) {
  throw new Error(`staged server missing (${stageServerEntry}); run \`npm run stage\` first`);
}

run(process.execPath, [path.join(desktopRoot, "scripts", "build.mjs")]);

// --- a local update feed -----------------------------------------------------
const workDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-verify-"));
const feedDir = path.join(workDir, "feed");
mkdirSync(feedDir, { recursive: true });

const feedVersion = "99.0.0";
const releaseDir = path.join(desktopRoot, "release");
const generatedFeed = path.join(releaseDir, "latest-mac.yml");

if (existsSync(generatedFeed)) {
  // Use the *real* feed metadata the packager produces, with the version
  // bumped so the installed app is considered outdated. The artifacts are
  // served unchanged, so the digests in the feed stay valid.
  const feedText = readFileSync(generatedFeed, "utf8").replace(/^version: .*$/m, `version: ${feedVersion}`);
  writeFileSync(path.join(feedDir, "latest-mac.yml"), feedText);
  for (const match of feedText.matchAll(/url: (\S+)/g)) {
    const artifact = path.join(releaseDir, match[1]);
    if (existsSync(artifact)) {
      cpSync(artifact, path.join(feedDir, match[1]));
      log(STEP, `feed artifact: ${match[1]}`);
    }
  }
  log(STEP, "using the packaged update feed (version bumped for the test)");
} else {
  // No packaged feed yet: build one from the real updatable artifact when it
  // exists (same format the packager writes), otherwise from a fixture.
  const realZip = readdirSync(releaseDir).find(
    (name) => name.endsWith(`-${process.arch}-mac.zip`) || (name.endsWith("-mac.zip") && name.includes(process.arch)),
  );
  let zipName;
  let sha512;
  let size;
  if (realZip) {
    const bytes = readFileSync(path.join(releaseDir, realZip));
    zipName = realZip;
    sha512 = createHash("sha512").update(bytes).digest("base64");
    size = bytes.length;
    cpSync(path.join(releaseDir, realZip), path.join(feedDir, realZip));
    log(STEP, `feed artifact: ${realZip} (${size} bytes)`);
  } else {
    zipName = `Paperclip-${feedVersion}-mac.zip`;
    const zipBody = Buffer.from("paperclip-update-feed-fixture\n");
    sha512 = createHash("sha512").update(zipBody).digest("base64");
    size = zipBody.length;
    writeFileSync(path.join(feedDir, zipName), zipBody);
  }
  writeFileSync(
    path.join(feedDir, "latest-mac.yml"),
    [
      `version: ${feedVersion}`,
      "files:",
      `  - url: ${zipName}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
      `path: ${zipName}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-01-01T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
}

const feedServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const name = decodeURIComponent(url.pathname.replace(/^\/updates\/?/, "")) || "latest-mac.yml";
  const file = path.join(feedDir, name);
  if (!file.startsWith(feedDir) || !existsSync(file)) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((resolve) => feedServer.listen(0, "127.0.0.1", resolve));
const feedPort = feedServer.address().port;
log(STEP, `update feed on http://127.0.0.1:${feedPort}/updates (version ${feedVersion})`);

// --- launch the shell ---------------------------------------------------------
const userData = path.join(workDir, "userData");
mkdirSync(userData, { recursive: true });

const packagedApp =
  process.env.PAPERCLIP_VERIFY_APP?.trim() ||
  path.join(
    desktopRoot,
    "release",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "Paperclip.app",
    "Contents",
    "MacOS",
    "Paperclip",
  );
const usePackaged = !useDev && existsSync(packagedApp);
if (!usePackaged && !useDev) {
  throw new Error(
    `packaged app not found at ${packagedApp}.\n` +
      "Run `npm run package:mac -- --dir` first, or pass --dev to verify the unpackaged shell.",
  );
}

const command = usePackaged ? packagedApp : resolveElectronBinary();
const commandArgs = usePackaged ? [] : [desktopRoot];
log(STEP, `launching ${usePackaged ? "packaged app" : "dev shell"}: ${command}`);

const child = spawn(command, commandArgs, {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PAPERCLIP_DESKTOP_VERIFY: "1",
    PAPERCLIP_DESKTOP_USER_DATA: userData,
    PAPERCLIP_DESKTOP_UPDATE_URL: `http://127.0.0.1:${feedPort}/updates`,
    PAPERCLIP_DESKTOP_EXPECT_UPDATE: usePackaged ? "available" : "disabled",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

const code = await new Promise((resolve) => {
  child.on("exit", (exitCode) => resolve(exitCode ?? 1));
});

feedServer.close();
rmSync(workDir, { recursive: true, force: true });

const passCount = (output.match(/^PASS: /gm) ?? []).length;
const failCount = (output.match(/^FAIL: /gm) ?? []).length;
const summary = output.match(/^\[verify\] (\d+)\/(\d+) checks passed$/m);
log(STEP, `checks: ${passCount} passed, ${failCount} failed (exit ${code})`);

// A shell that dies before it can report (a bundling error, a crash on
// startup) also exits 0 — the checks never ran. Only the app's own summary
// line proves the checks really executed, so its absence is a failure.
if (!summary) {
  log(STEP, "FAIL: the app exited without reporting the in-app check results");
  process.exitCode = 1;
} else if (failCount > 0 || Number(summary[1]) !== Number(summary[2]) || code !== 0) {
  process.exitCode = 1;
}
