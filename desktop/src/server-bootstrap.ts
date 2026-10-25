/**
 * Runs before the Paperclip server module is imported.
 *
 * The server spawns children with `process.execPath` and, for the agent
 * directory probe, with a deliberately EMPTY environment so no credentials
 * leak into the child. Under Electron that empty environment also loses
 * ELECTRON_RUN_AS_NODE, so the child starts as a GUI application and dies with
 * "Unable to find Electron app at ...".
 *
 * Pointing `process.execPath` at a shim that re-exports the Electron binary as
 * Node fixes every such spawn at once: the shim sets ELECTRON_RUN_AS_NODE
 * itself, so it does not matter what environment the child was given.
 *
 * This module is bundled as CommonJS (dist/server-bootstrap.cjs) because
 * Electron's Node runs it most reliably as CJS.
 */

import { pathToFileURL } from "node:url";

const entry = process.env.PAPERCLIP_DESKTOP_SERVER_ENTRY;
const shim = process.env.PAPERCLIP_DESKTOP_NODE_SHIM;

if (!entry) {
  process.stderr.write(
    "[desktop] server bootstrap: PAPERCLIP_DESKTOP_SERVER_ENTRY is missing\n",
  );
  process.exit(1);
}

if (shim) {
  // The server recognises itself as the main module by comparing argv[1] with
  // its own module URL, so argv has to look exactly as it would have when the
  // entry was run directly.
  process.argv = [shim, entry];
  process.execPath = shim;
}

import(pathToFileURL(entry).href).catch((error: unknown) => {
  process.stderr.write(
    `[desktop] server bootstrap failed to load ${entry}: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exit(1);
});
