import { app, dialog } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import updater from "electron-updater";

const { autoUpdater } = updater;

/**
 * Auto-update wiring (M3).
 *
 * The shell deliberately has no compiled-in update channel: a self-hosted
 * build should not phone home to somebody else's server. The feed is taken
 * from `PAPERCLIP_DESKTOP_UPDATE_URL` (generic provider) or from an
 * `app-update.yml` that the packager embeds when it is invoked with that
 * variable. A build with neither stays permanently "disabled".
 *
 * `autoDownload` is off: finding an update never mutates an install without an
 * explicit user decision.
 */

export type UpdaterState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterStatus {
  state: UpdaterState;
  message: string;
  version?: string;
  percent?: number;
}

export interface UpdaterOptions {
  log?: (message: string) => void;
  onStatus?: (status: UpdaterStatus) => void;
}

const FEED_ENV = "PAPERCLIP_DESKTOP_UPDATE_URL";

let initialized = false;
let disabledReason: string | null = null;
let log: (message: string) => void = () => {};
let onStatus: (status: UpdaterStatus) => void = () => {};
let status: UpdaterStatus = { state: "idle", message: "Not checked yet" };
let waiters: Array<(value: UpdaterStatus) => void> = [];

function setStatus(next: UpdaterStatus): UpdaterStatus {
  status = next;
  log(`status: ${next.state}${next.version ? ` v${next.version}` : ""}${next.message ? ` — ${next.message}` : ""}`);
  onStatus(status);
  if (next.state !== "checking" && next.state !== "downloading") {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(status);
  }
  return status;
}

export function currentUpdaterStatus(): UpdaterStatus {
  return status;
}

/** Why updates are unavailable, or null when a feed exists. */
export function updaterDisabledReason(): string | null {
  return disabledReason;
}

function resolveFeed(): { url: string } | { embedded: true } | { error: string } {
  const fromEnv = process.env[FEED_ENV]?.trim();
  if (fromEnv) {
    try {
      const url = new URL(fromEnv);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { error: `${FEED_ENV} must be http(s), got ${url.protocol}` };
      }
      return { url: fromEnv.replace(/\/+$/, "") };
    } catch {
      return { error: `${FEED_ENV} is not a valid URL: ${fromEnv}` };
    }
  }
  // electron-builder writes app-update.yml into Resources when a publish
  // provider is configured at package time.
  const embedded = path.join(process.resourcesPath, "app-update.yml");
  if (existsSync(embedded)) return { embedded: true };
  return { error: "no update feed configured (set PAPERCLIP_DESKTOP_UPDATE_URL or package with it)" };
}

export function initUpdater(options: UpdaterOptions = {}): UpdaterStatus {
  if (initialized) return status;
  initialized = true;
  log = options.log ?? (() => {});
  onStatus = options.onStatus ?? (() => {});

  if (!app.isPackaged) {
    disabledReason = "development build (not packaged)";
    return setStatus({ state: "disabled", message: disabledReason });
  }

  const feed = resolveFeed();
  if ("error" in feed) {
    disabledReason = feed.error;
    return setStatus({ state: "disabled", message: disabledReason });
  }
  disabledReason = null;
  if ("url" in feed) {
    log(`feed: ${feed.url}`);
    autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
  } else {
    log("feed: embedded app-update.yml");
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message?: unknown) => log(String(message ?? "")),
    warn: (message?: unknown) => log(`warn: ${String(message ?? "")}`),
    error: (message?: unknown) => log(`error: ${String(message ?? "")}`),
    debug: () => {},
  } as never;

  autoUpdater.on("checking-for-update", () => {
    setStatus({ state: "checking", message: "Checking for updates" });
  });
  autoUpdater.on("update-available", (info) => {
    setStatus({ state: "available", message: "Update available", version: info?.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    setStatus({
      state: "not-available",
      message: "Up to date",
      version: info?.version,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    setStatus({
      state: "downloading",
      message: `Downloading ${Math.round(progress?.percent ?? 0)}%`,
      percent: progress?.percent,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setStatus({ state: "downloaded", message: "Update ready to install", version: info?.version });
  });
  autoUpdater.on("error", (error) => {
    setStatus({ state: "error", message: error?.message ?? String(error) });
  });

  return setStatus({ state: "idle", message: "Ready to check" });
}

function waitForTerminal(timeoutMs: number): Promise<UpdaterStatus> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((entry) => entry !== finish);
      resolve(status);
    }, timeoutMs);
    const finish = (value: UpdaterStatus) => {
      clearTimeout(timer);
      resolve(value);
    };
    waiters.push(finish);
  });
}

/**
 * Check the feed and wait for a terminal state. Used by the menu (to decide
 * whether to offer the download), by the startup silent check and by the
 * verification script.
 */
export async function checkForUpdates(
  options: { interactive?: boolean; timeoutMs?: number } = {},
): Promise<UpdaterStatus> {
  if (disabledReason) return status;
  const pending = waitForTerminal(options.timeoutMs ?? 20_000);
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setStatus({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const result = await pending;

  if (options.interactive && result.state === "available") {
    const choice = await dialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: `Paperclip ${result.version ?? "update"} is available.`,
      detail: "Download it now? You can keep working while it downloads.",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) {
      try {
        setStatus({ state: "downloading", message: "Downloading update", version: result.version });
        await autoUpdater.downloadUpdate();
        const ready = await dialog.showMessageBox({
          type: "info",
          title: "Update ready",
          message: `Paperclip ${result.version ?? "update"} has been downloaded.`,
          detail: "Restart now to install it.",
          buttons: ["Restart now", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        if (ready.response === 0) autoUpdater.quitAndInstall();
      } catch (error) {
        setStatus({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return status;
}
