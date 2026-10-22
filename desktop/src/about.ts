import { BrowserWindow, app } from "electron";
import { dataHome, logsDir } from "./paths.js";

/**
 * The About window (M4).
 *
 * A native `role: "about"` dialog can only show the app name and version. The
 * information a support request actually needs is the *pair* of versions (the
 * shell and the Paperclip server it runs), the runtime, and where the data
 * lives — so this is a small dedicated window instead of a message box.
 */

export interface AboutInfo {
  serverUrl: string | null;
  serverVersion: string | null;
  updateState: string;
  updateMessage: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></div>`;
}

export function aboutHtml(info: AboutInfo): string {
  const rows = [
    row("Paperclip Desktop", app.getVersion()),
    row("Paperclip Server", info.serverVersion ?? "not running"),
    row("Server URL", info.serverUrl ?? "not running"),
    row("Electron", process.versions.electron ?? "n/a"),
    row("Chromium", process.versions.chrome ?? "n/a"),
    row("Node", process.versions.node),
    row("Platform", `${process.platform} ${process.arch}`),
    row("Updates", `${info.updateState} — ${info.updateMessage}`),
    row("Data folder", dataHome()),
    row("Logs folder", logsDir()),
  ].join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>About Paperclip</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:28px 30px; background:#18181b; color:#e4e4e7;
         font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  h1 { font-size:16px; margin:0 0 4px; }
  p.sub { margin:0 0 18px; color:#71717a; font-size:12px; }
  .row { display:flex; gap:14px; padding:5px 0; border-bottom:1px solid #27272a; }
  .row:last-child { border-bottom:none; }
  .k { flex:0 0 130px; color:#a1a1aa; }
  .v { flex:1 1 auto; word-break:break-all; }
</style></head>
<body>
  <h1>Paperclip Desktop</h1>
  <p class="sub">A local Paperclip workspace running on this machine.</p>
  ${rows}
</body></html>`;
}

let aboutWindow: BrowserWindow | null = null;

/** Open (or focus) the About window. */
export function openAboutWindow(info: AboutInfo): BrowserWindow {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return aboutWindow;
  }
  aboutWindow = new BrowserWindow({
    width: 520,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "About Paperclip",
    backgroundColor: "#18181b",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(aboutHtml(info))}`,
  );
  return aboutWindow;
}

/** The About window instance, if one is open (used by the verifier). */
export function currentAboutWindow(): BrowserWindow | null {
  return aboutWindow && !aboutWindow.isDestroyed() ? aboutWindow : null;
}
