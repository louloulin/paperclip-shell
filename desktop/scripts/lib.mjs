// Shared helpers for the desktop build/probe scripts.
//
// Everything here treats the Paperclip monorepo as a read-only build input:
// no script in this repository writes inside PAPERCLIP_REPO.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_ENV, SHIM_ENV, writeNodeShim } from "./node-shim.mjs";

export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shellRoot = path.resolve(desktopRoot, "..");
export const stageDir = path.join(desktopRoot, ".stage", "server");
export const stageServerEntry = path.join(stageDir, "dist", "index.js");

/** Staged server tree for one target arch (native deps are arch-specific). */
export function stageDirFor(arch) {
  return arch && arch !== process.arch ? path.join(desktopRoot, ".stage", `server-${arch}`) : stageDir;
}
export const MINIMUM_NODE_VERSION = "24.11.0";

const requireFromDesktop = createRequire(path.join(desktopRoot, "package.json"));

/** Paperclip checkout to consume. Defaults to the sibling directory. */
export function resolvePaperclipRepo() {
  const fromEnv = process.env.PAPERCLIP_REPO?.trim();
  const candidate = fromEnv ? path.resolve(fromEnv) : path.resolve(shellRoot, "..", "paperclip");
  if (!existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
    throw new Error(
      `PAPERCLIP_REPO does not look like a Paperclip checkout (no pnpm-workspace.yaml): ${candidate}\n` +
        `Set PAPERCLIP_REPO=/path/to/paperclip`,
    );
  }
  return candidate;
}

export function log(step, message) {
  process.stdout.write(`[${step}] ${message}\n`);
}

/** Run a command with inherited stdio; throw on non-zero exit. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result;
}

/** Run a command and capture stdout as a string. */
export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

/** Resolve the Electron binary path (the electron package exports the binary path). */
export function resolveElectronBinary() {
  if (!existsSync(path.join(desktopRoot, "node_modules", "electron"))) {
    throw new Error("electron is not installed. Run `npm install` in desktop/ first.");
  }
  const electronPath = requireFromDesktop("electron");
  if (typeof electronPath !== "string" || !existsSync(electronPath)) {
    throw new Error(`electron binary not found at ${String(electronPath)}`);
  }
  return electronPath;
}

/**
 * Spawn the staged Paperclip server.
 * Default runtime is the Electron binary in `ELECTRON_RUN_AS_NODE` mode;
 * PAPERCLIP_DESKTOP_NODE_BIN switches to a standalone Node runtime instead.
 *
 * The server is started through the bundled bootstrap so that its
 * `process.execPath` points at a Node shim: the server spawns children with
 * that path and, for the agent directory probe, with an EMPTY environment —
 * under Electron that would drop ELECTRON_RUN_AS_NODE and the child would try
 * to open a GUI app.
 */
export function spawnServer({
  electronBinary,
  entry = stageServerEntry,
  env,
  cwd = stageDir,
  shimPath,
}) {
  const standalone = env.PAPERCLIP_DESKTOP_NODE_BIN?.trim();
  const command = standalone || electronBinary;
  const childEnv = { ...env };
  if (standalone) delete childEnv.ELECTRON_RUN_AS_NODE;
  else childEnv.ELECTRON_RUN_AS_NODE = "1";

  childEnv[ENTRY_ENV] = entry;
  if (!standalone) {
    const shim = writeNodeShim(
      shimPath ?? path.join(os.tmpdir(), "paperclip-desktop-node"),
      electronBinary,
    );
    childEnv[SHIM_ENV] = shim;
  }

  return spawn(command, [serverBootstrapEntry()], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The bundled bootstrap that loads the server with a Node-compatible execPath. */
export function serverBootstrapEntry() {
  return path.join(desktopRoot, "dist", "server-bootstrap.cjs");
}

export function compareNodeVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, "").split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const l = a[index] ?? 0;
    const r = b[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

export async function waitFor(predicate, { timeoutMs = 120_000, intervalMs = 500, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    onTick?.();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms${lastError ? `: ${lastError?.message ?? lastError}` : ""}`,
  );
}
