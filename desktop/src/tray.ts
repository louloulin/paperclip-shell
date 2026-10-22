import { app, Menu, nativeImage, Tray } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tray presence (M4): shows what the local server is doing and keeps the
 * maintenance actions (data/log folders, log export, restart, updates) one
 * click away, including while the main window is busy starting up.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type TrayPhase = "starting" | "running" | "stopped";

export interface TrayState {
  phase: TrayPhase;
  serverUrl?: string;
  updateLabel?: string;
}

export interface TrayActions {
  openWindow: () => void;
  openDataFolder: () => void;
  openLogsFolder: () => void;
  exportLogs: () => void;
  restartServer: () => void;
  checkUpdates: () => void;
  quit: () => void;
}

function trayIconPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "trayTemplate.png")]
    : [path.join(moduleDir, "..", "build", "trayTemplate.png")];
  // Dev builds that have not run `npm run icons` still get a tray; the app icon
  // is visibly wrong as a template image, but a missing tray is worse.
  candidates.push(
    app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.join(moduleDir, "..", "build", "icon-1024.png"),
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function createTray(actions: TrayActions, initial: TrayState): ShellTray {
  const iconPath = trayIconPath();
  const image = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  if (!image.isEmpty()) image.setTemplateImage(true);

  const tray = new Tray(image) as ShellTray;
  tray.setToolTip("Paperclip");

  let state = initial;
  const render = () => {
    const statusLabel =
      state.phase === "running"
        ? `Running on ${state.serverUrl ?? "local server"}`
        : state.phase === "starting"
          ? "Starting local server…"
          : "Server stopped";
    const menu = Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: "separator" },
      { label: "Open Paperclip", click: actions.openWindow, enabled: state.phase === "running" },
      { type: "separator" },
      { label: "Open data folder", click: actions.openDataFolder },
      { label: "Open logs folder", click: actions.openLogsFolder },
      { label: "Export logs…", click: actions.exportLogs },
      { label: "Restart local server", click: actions.restartServer },
      { type: "separator" },
      {
        label: state.updateLabel ? `Check for updates… (${state.updateLabel})` : "Check for updates…",
        click: actions.checkUpdates,
      },
      { type: "separator" },
      { label: "Quit Paperclip", click: actions.quit },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`Paperclip — ${statusLabel.replace(/…$/, "")}`);
  };
  render();

  tray.setShellState = (next: TrayState) => {
    state = next;
    render();
  };
  tray.getShellState = () => state;
  return tray;
}

export interface ShellTray extends Tray {
  setShellState(state: TrayState): void;
  getShellState(): TrayState;
}
