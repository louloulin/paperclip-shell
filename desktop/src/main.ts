import { app, BrowserWindow, Menu, shell, dialog, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertServerStaged, dataHome, logsDir, pluginsDir, serverLogFile, serverRoot } from "./paths.js";
import { startServer, type StartedServer } from "./server-supervisor.js";
import { clearUserPathCache } from "./user-path.js";
import { errorPage, loadingPage } from "./loading-page.js";
import { createTray, type ShellTray, type TrayState } from "./tray.js";
import { checkForUpdates, currentUpdaterStatus, initUpdater, updaterDisabledReason } from "./updater.js";
import { defaultLogBundleName, exportLogs } from "./logs.js";
import { openAboutWindow } from "./about.js";
import { runVerification } from "./verify.js";
import { installShellFrame } from "./frame.js";
import { SHELL_BG } from "./theme.js";
import {
  currentAgentLanguage,
  installBundled,
  isBundled,
  isEnabled,
  isInstalled,
  rendererPayload,
  setAgentLanguage,
  setEnabled,
  type AgentLanguage,
} from "./plugins.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.PAPERCLIP_DESKTOP_SMOKE === "1";
const VERIFY = process.env.PAPERCLIP_DESKTOP_VERIFY === "1";
// macOS: no native title bar; traffic lights sit over the app, which reserves
// a 30px band. Other platforms keep their native frame.
const CUSTOM_TITLEBAR = process.platform === "darwin";

// Allow an isolated profile (used by the verifier and by anyone who wants a
// second, throwaway instance). Must happen before any getPath("userData").
const userDataOverride = process.env.PAPERCLIP_DESKTOP_USER_DATA?.trim();
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));

let mainWindow: BrowserWindow | null = null;
let supervisor: StartedServer | null = null;
let tray: ShellTray | null = null;
let quitting = false;
let serverVersion: string | null = null;

function log(message: string): void {
  process.stdout.write(`[desktop] ${message}\n`);
}

const STAGE_PATTERNS: Array<{ stage: string; pattern: RegExp; detail: (m: RegExpMatchArray) => string }> = [
  {
    stage: "migrate",
    pattern: /Applying (\d+) pending migrations/i,
    detail: (m) => `Applying ${m[1]} migrations`,
  },
  {
    stage: "migrate",
    pattern: /first-run embedded PostgreSQL setup/i,
    detail: () => "Applying migrations",
  },
  {
    stage: "database",
    pattern: /Embedded PostgreSQL (?:ready|cluster already exists|port is in use|already running)/i,
    detail: () => "Embedded PostgreSQL",
  },
];

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // One background colour for the window, the loading screen and About: no
    // white flash and no seam between native chrome and content.
    backgroundColor: SHELL_BG,
    title: "Paperclip",
    ...(CUSTOM_TITLEBAR
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 17 },
        }
      : {}),
    webPreferences: {
      preload: path.join(moduleDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installShellFrame(window.webContents, { inset: CUSTOM_TITLEBAR });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  return window;
}

/** Push the current server/updater state into the tray menu. */
function setTrayState(state: Partial<TrayState>): void {
  if (!tray) return;
  const update = currentUpdaterStatus();
  const updateLabel =
    update.state === "available"
      ? `update ${update.version ?? ""}`.trim()
      : update.state === "downloaded"
        ? "update ready"
        : undefined;
  tray.setShellState({
    phase: state.phase ?? "starting",
    serverUrl: state.serverUrl,
    updateLabel,
  });
}

function showAbout(): void {
  const status = currentUpdaterStatus();
  openAboutWindow({
    serverUrl: supervisor?.baseUrl ?? null,
    serverVersion,
    updateState: status.state,
    updateMessage: status.message,
  });
}

async function exportLogsAction(): Promise<void> {
  const suggested = path.join(app.getPath("downloads"), defaultLogBundleName());
  const choice = await dialog.showSaveDialog({
    title: "Export Paperclip logs",
    defaultPath: suggested,
    filters: [{ name: "Log bundle", extensions: ["log"] }],
  });
  if (choice.canceled || !choice.filePath) return;
  try {
    const result = exportLogs(choice.filePath, {
      serverUrl: supervisor?.baseUrl ?? null,
      serverVersion,
    });
    log(`logs exported: ${result.path} (${result.files} files, ${result.bytes} bytes)`);
    void dialog
      .showMessageBox({
        type: "info",
        message: "Logs exported",
        detail: `${result.path}\n\n${result.files} file(s), ${result.bytes} bytes.`,
        buttons: ["Reveal in Finder", "Done"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) shell.showItemInFolder(result.path);
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAIL log export: ${message}`);
    void dialog.showMessageBox({ type: "error", message: "Logs could not be exported", detail: message });
  }
}

async function checkUpdatesAction(): Promise<void> {
  const reason = updaterDisabledReason();
  if (reason) {
    void dialog.showMessageBox({
      type: "info",
      message: "Automatic updates are not configured",
      detail: `${reason}\n\nSet PAPERCLIP_DESKTOP_UPDATE_URL to a generic update feed, or package the app with an app-update.yml.`,
    });
    return;
  }
  await checkForUpdates({ interactive: true, timeoutMs: 30_000 });
}

// --- plugins -----------------------------------------------------------------

const ZH_PACK_ID = "paperclip-zh-pack";

async function reloadMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !supervisor) return;
  // The preload writes the pack's settings mirror on every navigation, so a
  // reload is the only step needed to apply a menu change. Writing it here as
  // well would target whichever origin happens to be loaded, which is exactly
  // the port-dependent state the bootstrap is meant to replace.
  await mainWindow.loadURL(supervisor.baseUrl);
}

async function toggleZhPack(): Promise<void> {
  if (!isInstalled(ZH_PACK_ID)) {
    const installed = installBundled(ZH_PACK_ID);
    if (!installed) return;
    setEnabled(ZH_PACK_ID, true);
  } else {
    setEnabled(ZH_PACK_ID, !isEnabled(ZH_PACK_ID));
  }
  installMenu();
  await reloadMainWindow();
}

async function setAgentReplyLanguage(value: AgentLanguage): Promise<void> {
  setAgentLanguage(value);
  installMenu();
  await reloadMainWindow();
}

function pluginsSubmenu(): Electron.MenuItemConstructorOptions[] {
  const zhInstalled = isInstalled(ZH_PACK_ID);
  const language = currentAgentLanguage();
  const replyLanguage = (value: AgentLanguage, label: string): Electron.MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: language === value,
    click: () => void setAgentReplyLanguage(value),
  });
  return [
    {
      label: "中文语言包 (Chinese language pack)",
      type: "checkbox",
      checked: zhInstalled && isEnabled(ZH_PACK_ID),
      // A build without the staged catalog has nothing to install from.
      enabled: zhInstalled || isBundled(ZH_PACK_ID),
      click: () => void toggleZhPack(),
    },
    {
      label: "智能体回复语言 (agent reply language)",
      enabled: zhInstalled,
      submenu: [
        replyLanguage("auto", "跟随界面 (follow UI)"),
        replyLanguage("zh-CN", "简体中文"),
        replyLanguage("en", "English"),
        replyLanguage("off", "不干预 (off)"),
      ],
    },
    { type: "separator" },
    { label: "打开插件文件夹 (open plugins folder)", click: () => void shell.openPath(pluginsDir()) },
  ];
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Paperclip",
      submenu: [
        { label: "About Paperclip", click: () => showAbout() },
        { type: "separator" },
        { label: "Open data folder", click: () => void shell.openPath(dataHome()) },
        { label: "Open logs folder", click: () => void shell.openPath(logsDir()) },
        { label: "Export logs…", click: () => void exportLogsAction() },
        {
          label: "Restart local server",
          click: () => void restartServer(),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Plugins",
      submenu: pluginsSubmenu(),
    },
    {
      label: "Help",
      submenu: [{ label: "Check for updates…", click: () => void checkUpdatesAction() }],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installTray(): void {
  tray = createTray(
    {
      openWindow: () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
      openDataFolder: () => void shell.openPath(dataHome()),
      openLogsFolder: () => void shell.openPath(logsDir()),
      exportLogs: () => void exportLogsAction(),
      restartServer: () => void restartServer(),
      checkUpdates: () => void checkUpdatesAction(),
      quit: () => app.quit(),
    },
    { phase: "starting" },
  );
}

/** Advance the startup screen; a destroyed/loading window is not an error. */
async function setLoadingStage(stage: string, detail?: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.webContents.executeJavaScript(
      `window.__setStage && window.__setStage(${JSON.stringify(stage)}, ${JSON.stringify(detail ?? null)})`,
    );
  } catch {
    // The loading document was replaced (or the window closed) — nothing to show.
  }
}

async function restartServer(): Promise<void> {
  if (!mainWindow) return;
  await supervisor?.stop();
  supervisor = null;
  serverVersion = null;
  setTrayState({ phase: "starting" });
  // Re-read the login shell: the user may have installed a CLI since launch.
  clearUserPathCache();
  await mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(loadingPage({ titleBarInset: CUSTOM_TITLEBAR }))}`,
  );
  await boot();
}

async function fetchServerVersion(baseUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const payload = (await response.json()) as { version?: unknown };
    return typeof payload.version === "string" ? payload.version : null;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  if (!mainWindow) return;
  try {
    assertServerStaged();
    log(`server root: ${serverRoot()}`);
    await setLoadingStage("env");
    supervisor = await startServer({
      onEnvResolved: ({ pathSource, pathEntries }) => {
        log(`PATH from ${pathSource} (${pathEntries} entries)`);
        void setLoadingStage("server", `PATH from ${pathSource}`);
      },
      onLog: (line) => {
        // pino JSON: only surface warn(40)/error(50)/fatal(60).
        if (/"level":(?:40|50|60)\b/.test(line)) log(`server: ${line.slice(0, 400)}`);
        for (const { stage, pattern, detail } of STAGE_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            void setLoadingStage(stage, detail(match));
            break;
          }
        }
      },
      onExit: ({ code, signal }) => {
        setTrayState({ phase: "stopped" });
        if (!quitting && code !== 0) {
          log(`server exited unexpectedly (code=${code} signal=${signal})`);
        }
      },
    });
    log(`server ready on ${supervisor.baseUrl}`);
    serverVersion = await fetchServerVersion(supervisor.baseUrl);
    log(`server version: ${serverVersion ?? "unknown"}`);
    setTrayState({ phase: "running", serverUrl: supervisor.baseUrl });
    await setLoadingStage("ui");
    await mainWindow.loadURL(supervisor.baseUrl);
    if (SMOKE) {
      const title = await mainWindow.webContents.executeJavaScript(
        `({ title: document.title, rootChildren: document.getElementById("root")?.childElementCount ?? 0, href: location.href })`,
      );
      const ok = title.rootChildren > 0;
      log(`${ok ? "PASS" : "FAIL"} smoke: ui mounted (rootChildren=${title.rootChildren}, href=${title.href})`);
      quitting = true;
      await supervisor.stop();
      app.exit(ok ? 0 : 1);
    } else if (VERIFY) {
      const failures = await runVerification({
        tray,
        window: mainWindow,
        serverUrl: supervisor?.baseUrl ?? null,
        serverVersion,
        reloadUi: async () => {
          if (!mainWindow || mainWindow.isDestroyed() || !supervisor) return;
          await mainWindow.loadURL(supervisor.baseUrl);
        },
      });
      quitting = true;
      await supervisor?.stop();
      app.exit(failures === 0 ? 0 : 1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAIL startup: ${message}`);
    let tail = "";
    try {
      tail = readFileSync(serverLogFile(), "utf8").split("\n").slice(-25).join("\n");
    } catch {
      // No log yet.
    }
    await mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        errorPage(`${message}\n\n${tail}`, logsDir(), { titleBarInset: CUSTOM_TITLEBAR }),
      )}`,
    );
    if (SMOKE || VERIFY) {
      quitting = true;
      await supervisor?.stop();
      app.exit(1);
    } else {
      void dialog.showMessageBox({ type: "error", message: "Paperclip couldn’t start", detail: message });
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting || !supervisor) return;
    event.preventDefault();
    quitting = true;
    void supervisor.stop().then(() => app.quit());
  });

  void app.whenReady().then(async () => {
    // Plugin payloads are pulled by the preload over synchronous IPC, so this
    // handler must exist before the first window loads.
    ipcMain.on("plugins:renderer-payload", (event, href) => {
      event.returnValue = rendererPayload(typeof href === "string" ? href : "");
    });
    installMenu();
    installTray();
    initUpdater({
      log: (message) => log(`updater: ${message}`),
      onStatus: () => setTrayState({}),
    });
    mainWindow = createWindow();
    await mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(loadingPage({ titleBarInset: CUSTOM_TITLEBAR }))}`,
    );
    await boot();
  });
}
