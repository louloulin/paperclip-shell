import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A tiny POSIX shim that runs the bundled runtime as Node.
 *
 * The Paperclip server spawns children with `process.execPath` and, for the
 * agent directory probe, with a deliberately EMPTY environment so that no
 * credentials leak into the child. Under Electron that empty environment also
 * loses ELECTRON_RUN_AS_NODE, so the child starts as a GUI application and dies
 * with "Unable to find Electron app at ...".
 *
 * Pointing the server's `process.execPath` at this shim fixes every such spawn
 * at once: the shim sets ELECTRON_RUN_AS_NODE itself, so it does not matter
 * what environment the child was handed.
 *
 * Shared by the shell (src/server-supervisor.ts) and the scripts
 * (scripts/lib.mjs) so both spawn the server the same way.
 */

export const SHIM_ENV = "PAPERCLIP_DESKTOP_NODE_SHIM";
export const ENTRY_ENV = "PAPERCLIP_DESKTOP_SERVER_ENTRY";

/** POSIX single-quoting: the only escape inside '...' is '\'' . */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write the shim and return its path.
 *
 * The shim points at `runtimeBinary` (the Electron binary) and must be
 * executable: the server runs it through `execFile`, which does not use a shell.
 */
export function writeNodeShim(shimPath, runtimeBinary) {
  mkdirSync(path.dirname(shimPath), { recursive: true });
  const script = [
    "#!/bin/sh",
    "# Paperclip desktop: run the bundled runtime as Node.",
    "# Generated on every launch; do not edit.",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(runtimeBinary)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(shimPath, script, "utf8");
  chmodSync(shimPath, 0o755);
  return shimPath;
}
