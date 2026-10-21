import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertServerStaged, dataHome, logsDir, serverLogFile, serverRoot } from "./paths.js";
import { startServer, type StartedServer } from "./server-supervisor.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.PAPERCLIP_DESKTOP_SMOKE === "1";

let mainWindow: BrowserWindow | null = null;
let supervisor: StartedServer | null = null;
let quitting = false;

function log(message: string): void {
  process.stdout.write(`[desktop] ${message}\n`);
}

function loadingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paperclip</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#18181b; color:#e4e4e7; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .box { text-align:center; }
  .title { font-size:15px; font-weight:600; }
  .hint { margin-top:6px; color:#a1a1aa; }
</style></head>
<body><div class="box"><div class="title">Starting Paperclip…</div>
<div class="hint">Preparing the local server and database.</div></div></body></html>`;
}

function errorPage(message: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paperclip</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#18181b; color:#e4e4e7; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .box { max-width:640px; padding:32px; }
  h1 { font-size:16px; margin:0 0 8px; }
  pre { white-space:pre-wrap; word-break:break-word; background:#27272a; padding:12px; border-radius:8px;
        font-size:12px; color:#d4d4d8; max-height:280px; overflow:auto; }
  p { color:#a1a1aa; }
</style></head>
<body><div class="box">
  <h1>Paperclip couldn’t start</h1>
  <p>The local server did not become ready. Details below; full logs are in <code>${escape(logsDir())}</code>.</p>
  <pre>${escape(message)}</pre>
</div></body></html>`;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#18181b",
    title: "Paperclip",
    webPreferences: {
      preload: path.join(moduleDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  return window;
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Paperclip",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Open data folder", click: () => void shell.openPath(dataHome()) },
        { label: "Open logs folder", click: () => void shell.openPath(logsDir()) },
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
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function restartServer(): Promise<void> {
  if (!mainWindow) return;
  await supervisor?.stop();
  supervisor = null;
  await mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(loadingPage())}`,
  );
  await boot();
}

async function boot(): Promise<void> {
  if (!mainWindow) return;
  try {
    assertServerStaged();
    log(`server root: ${serverRoot()}`);
    supervisor = await startServer({
      onLog: (line) => {
        // pino JSON: only surface warn(40)/error(50)/fatal(60).
        if (/"level":(?:40|50|60)\b/.test(line)) log(`server: ${line.slice(0, 400)}`);
      },
      onExit: ({ code, signal }) => {
        if (!quitting && code !== 0) {
          log(`server exited unexpectedly (code=${code} signal=${signal})`);
        }
      },
    });
    log(`server ready on ${supervisor.baseUrl}`);
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
      `data:text/html;charset=utf-8,${encodeURIComponent(errorPage(`${message}\n\n${tail}`))}`,
    );
    if (SMOKE) {
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
    installMenu();
    mainWindow = createWindow();
    await mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(loadingPage())}`,
    );
    await boot();
  });
}
