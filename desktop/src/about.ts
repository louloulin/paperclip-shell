import { BrowserWindow, app } from "electron";
import { dataHome, logsDir } from "./paths.js";
import { backdropHtml, logoHtml, shellCss, SHELL_BG } from "./theme.js";

/**
 * The About window (M4).
 *
 * A native `role: "about"` dialog can only show the app name and version. The
 * information a support request actually needs is the *pair* of versions (the
 * shell and the Paperclip server it runs), the runtime, and where the data
 * lives — so this is a small dedicated window instead of a message box.
 *
 * It uses the same tokens, backdrop and 1px edge as the loading screen so the
 * shell reads as one surface.
 */

export interface AboutInfo {
  serverUrl: string | null;
  serverVersion: string | null;
  updateState: string;
  updateMessage: string;
  /** Preview harness override; the app always reports `app.getVersion()`. */
  shellVersion?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function row(label: string, value: string, mono = false): string {
  return `<div class="row"><span class="k">${escapeHtml(label)}</span><span class="v${mono ? " mono" : ""}">${escapeHtml(value)}</span></div>`;
}

function section(title: string, rows: string): string {
  return `<div class="section"><div class="section-title">${escapeHtml(title)}</div>${rows}</div>`;
}

export function aboutHtml(info: AboutInfo): string {
  const version = info.shellVersion ?? app.getVersion();
  const server = section(
    "Server",
    [
      row("Paperclip Server", info.serverVersion ?? "not running"),
      row("Server URL", info.serverUrl ?? "not running", true),
      row("Updates", `${info.updateState} — ${info.updateMessage}`),
    ].join(""),
  );
  const runtime = section(
    "Runtime",
    [
      row("Electron", process.versions.electron ?? "n/a"),
      row("Chromium", process.versions.chrome ?? "n/a"),
      row("Node", process.versions.node),
      row("Platform", `${process.platform} ${process.arch}`),
    ].join(""),
  );
  const storage = section(
    "Storage",
    [row("Data folder", dataHome(), true), row("Logs folder", logsDir(), true)].join(""),
  );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About Paperclip</title>
<style>
${shellCss()}
body { overflow: auto; }
.card {
  width: min(540px, calc(100vw - 40px));
  padding: 26px 28px 22px;
}
.head { display: flex; align-items: center; gap: 15px; }
.logo { width: 56px; height: 56px; }
.logo .tile { border-radius: 16px; }
.logo svg { width: 30px; height: 30px; }
.logo .halo { inset: -7px; border-radius: 20px; }
h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.01em; }
.meta { margin: 2px 0 0; font-size: 11.5px; color: var(--shell-muted); font-variant-numeric: tabular-nums; }
.sub { margin: 16px 0 4px; color: var(--shell-muted); font-size: 12px; }
.section { margin-top: 16px; }
.section-title {
  margin-bottom: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--shell-faint);
}
.row {
  display: flex;
  gap: 14px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
  font-size: 12px;
}
.row:last-child { border-bottom: none; }
.k { flex: 0 0 124px; color: var(--shell-muted); }
.v { flex: 1 1 auto; word-break: break-all; }
.v.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #d4d4d8;
  /* Break after path separators first, not inside a directory name. */
  word-break: normal;
  overflow-wrap: anywhere;
}
.foot { margin-top: 16px; color: var(--shell-faint); font-size: 11px; }
</style></head>
<body>
${backdropHtml("about")}
<main class="scene">
  <section class="card" role="document">
    <div class="head">
      ${logoHtml({ animated: false })}
      <div>
        <h1>Paperclip Desktop</h1>
        <p class="meta">Version ${escapeHtml(version)} · ${escapeHtml(process.platform)} ${escapeHtml(process.arch)}</p>
      </div>
    </div>
    <p class="sub">A local Paperclip workspace running on this machine. No account or external service is required.</p>
    ${server}
    ${runtime}
    ${storage}
    <div class="foot">Paperclip Desktop ${escapeHtml(version)}</div>
  </section>
</main>
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
    width: 660,
    height: 740,
    minWidth: 520,
    minHeight: 560,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "About Paperclip",
    backgroundColor: SHELL_BG,
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
