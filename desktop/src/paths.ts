import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Root of the staged Paperclip server tree.
 * Packaged: <app>/Contents/Resources/server (electron-builder extraResources).
 * Dev: desktop/.stage/server.
 */
export function serverRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "server");
  return path.resolve(moduleDir, "..", ".stage", "server");
}

export function serverEntry(): string {
  return path.join(serverRoot(), "dist", "index.js");
}

/** Isolated data home: never touches the CLI's ~/.paperclip. */
export function dataHome(): string {
  return path.join(app.getPath("userData"), "paperclip");
}

export function logsDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

/**
 * Plugins the user has installed (one directory per plugin, each with a
 * plugin.json manifest). Created on demand; may not exist yet.
 */
export function pluginsDir(): string {
  return path.join(app.getPath("userData"), "plugins");
}

/**
 * Plugin catalog bundled with the shell. Packaged:
 * <app>/Contents/Resources/plugins (electron-builder extraResources).
 * Dev: desktop/resources/plugins (staged by scripts/build.mjs).
 */
export function bundledPluginsDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "plugins");
  return path.resolve(moduleDir, "..", "resources", "plugins");
}

export function serverLogFile(): string {
  return path.join(logsDir(), "server.log");
}

export function assertServerStaged(): void {
  const entry = serverEntry();
  if (!existsSync(entry)) {
    throw new Error(
      `Staged Paperclip server not found at ${entry}.\n` +
        `Run \`npm run stage\` in desktop/ first (or set PAPERCLIP_DESKTOP_SERVER_ROOT).`,
    );
  }
}

/** Optional override used by tests and by operators with a prebuilt server tree. */
export function serverRootOverride(): string | null {
  const override = process.env.PAPERCLIP_DESKTOP_SERVER_ROOT?.trim();
  return override ? path.resolve(override) : null;
}
