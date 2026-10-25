import { app, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentAboutWindow, openAboutWindow } from "./about.js";
import { defaultLogBundleName, exportLogs } from "./logs.js";
import { checkForUpdates, currentUpdaterStatus, updaterDisabledReason } from "./updater.js";
import type { ShellTray } from "./tray.js";
import {
  installBundled,
  isBundled,
  isEnabled,
  isInstalled,
  setEnabled,
  type AgentLanguage,
} from "./plugins.js";

/**
 * In-app verification (M3/M4).
 *
 * The shell's own features (tray, About window, log export, update channel)
 * live in the Electron main process, so a script outside the app cannot assert
 * them. This module runs a scripted sequence inside the app and prints one
 * `PASS:`/`FAIL:` line per check; scripts/verify-shell.mjs drives it and turns
 * the result into an exit code.
 */

export interface VerifyContext {
  tray: ShellTray | null;
  window: BrowserWindow | null;
  serverUrl: string | null;
  serverVersion: string | null;
  /** Reload the UI from the server (plugins toggle + reload through here). */
  reloadUi: () => Promise<void>;
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}: ${name} — ${detail}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Optional visual evidence: PAPERCLIP_DESKTOP_CAPTURE_DIR=<dir>. */
function captureDir(): string | null {
  const dir = process.env.PAPERCLIP_DESKTOP_CAPTURE_DIR?.trim();
  return dir ? path.resolve(dir) : null;
}

async function capture(window: BrowserWindow | null, name: string): Promise<void> {
  const dir = captureDir();
  if (!dir || !window || window.isDestroyed()) return;
  try {
    mkdirSync(dir, { recursive: true });
    const image = await window.webContents.capturePage();
    const file = path.join(dir, name);
    writeFileSync(file, image.toPNG());
    process.stdout.write(`[verify] captured ${file}\n`);
  } catch (error) {
    process.stdout.write(`[verify] capture failed: ${String(error)}\n`);
  }
}

const ZH_PACK_ID = "paperclip-zh-pack";

/** Distinctive sidebar strings; shared with the pack's dictionary. */
const ZH_MARKERS = ["新建任务", "仪表盘", "收件箱", "搜索", "智能体"];
const EN_MARKERS = ["New Task", "Dashboard", "Inbox", "Search"];

/**
 * Wait until the body text satisfies `pred` (the SPA may take a while to
 * mount after a reload, much longer under Rosetta). Returns the text.
 */
async function waitForUiText(
  window: BrowserWindow,
  pred: (text: string) => boolean,
  what: string,
): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const text = await window.webContents.executeJavaScript(`document.body.innerText`);
      if (typeof text === "string") {
        last = text;
        if (pred(text)) return text;
      }
    } catch {
      // Mid-navigation; keep polling.
    }
    await sleep(500);
  }
  throw new Error(`UI did not reach the expected state within 30s (${what}); text=${last.slice(0, 120)}`);
}

function writePackSettings(window: BrowserWindow, enabled: boolean, agentLanguage: AgentLanguage): Promise<void> {
  const settings = { enabled, override: enabled ? "zh-CN" : "en", agentLanguage };
  return window.webContents
    .executeJavaScript(
      `localStorage.setItem("paperclip-zh-pack.settings", ${JSON.stringify(JSON.stringify(settings))}); true`,
    )
    .then(() => undefined);
}

async function verifyPlugins(ctx: VerifyContext): Promise<void> {
  const nameOn = "plugins: Chinese language pack installs and translates the UI";
  const nameOff = "plugins: disabling the pack restores the original English UI";
  const window = ctx.window;
  if (!window || window.isDestroyed()) {
    record(nameOn, false, "no main window");
    record(nameOff, false, "no main window");
    return;
  }
  if (!isBundled(ZH_PACK_ID)) {
    const detail = `bundled pack missing (${isInstalled(ZH_PACK_ID) ? "installed but catalog empty" : "no catalog entry"})`;
    record(nameOn, false, detail);
    record(nameOff, false, detail);
    return;
  }
  try {
    // Install into this (fresh) profile, exactly like the menu command does.
    installBundled(ZH_PACK_ID);
    setEnabled(ZH_PACK_ID, true);
    await writePackSettings(window, true, "auto");
    await ctx.reloadUi();
    const zhText = await waitForUiText(
      window,
      (text) => ZH_MARKERS.some((marker) => text.includes(marker)),
      "translated sidebar",
    );
    const patchedZh = await window.webContents.executeJavaScript(
      `window.__paperclipZhPackPatched === true`,
    );
    record(
      nameOn,
      patchedZh === true,
      `patched=${patchedZh} translated=${ZH_MARKERS.filter((m) => zhText.includes(m)).join("/")} installed=${isInstalled(ZH_PACK_ID)} enabled=${isEnabled(ZH_PACK_ID)}`,
    );

    setEnabled(ZH_PACK_ID, false);
    await writePackSettings(window, false, "auto");
    await ctx.reloadUi();
    const enText = await waitForUiText(
      window,
      (text) => EN_MARKERS.some((marker) => text.includes(marker)),
      "english sidebar",
    );
    const patchedEn = await window.webContents.executeJavaScript(
      `window.__paperclipZhPackPatched === true`,
    );
    const enOk =
      patchedEn === false &&
      EN_MARKERS.some((marker) => enText.includes(marker)) &&
      !ZH_MARKERS.some((marker) => enText.includes(marker));
    record(nameOff, enOk, `patched=${patchedEn} english=${EN_MARKERS.filter((m) => enText.includes(m)).join("/")}`);

    // Leave the pack enabled so later checks (and screenshots) run on it.
    setEnabled(ZH_PACK_ID, true);
    await writePackSettings(window, true, "auto");
    await ctx.reloadUi();
    await waitForUiText(
      window,
      (text) => ZH_MARKERS.some((marker) => text.includes(marker)),
      "translated sidebar (restored)",
    );
  } catch (error) {
    record(nameOn, false, String(error));
    record(nameOff, false, String(error));
  }
}

async function verifyFrame(ctx: VerifyContext): Promise<void> {
  const window = ctx.window;
  if (!window || window.isDestroyed()) {
    record("chrome: title bar is integrated with the app", false, "no main window");
    return;
  }
  // insertCSS + the drag strip land on dom-ready; give them a moment.
  let style: { dragbar: boolean; paddingTop: string; seam: string } | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    style = await window.webContents.executeJavaScript(
      `(() => ({
         dragbar: Boolean(document.getElementById("paperclip-drag-strip")),
         paddingTop: getComputedStyle(document.body).paddingTop,
         seam: getComputedStyle(document.body, "::after").borderTopWidth,
       }))()`,
    );
    if (style.dragbar) break;
    await sleep(200);
  }
  // The 30px band holds the traffic lights and is draggable; a 0px ::after
  // border proves there is no hairline between title bar and content.
  record(
    "chrome: title bar is integrated with the app",
    style?.dragbar === true && style.paddingTop === "30px" && style.seam === "0px",
    JSON.stringify(style),
  );

  // The shell sizes itself with h-dvh; that must be reduced by the band or the
  // bottom of the UI (composer, bottom nav) is clipped by body overflow:hidden.
  // Polled: after plugin checks the app may still be mounting (slow under
  // Rosetta), and a half-mounted shell would measure nonsense.
  let layout: { innerHeight: number; rootBottom: number | null; docScrollHeight: number } | null = null;
  let ok = false;
  for (let attempt = 0; attempt < 10 && !ok; attempt += 1) {
    layout = await window.webContents.executeJavaScript(
      `(() => {
         const shell = document.querySelector(".h-dvh") ?? document.getElementById("root");
         const rect = shell?.getBoundingClientRect();
         return {
           innerHeight: window.innerHeight,
           rootBottom: rect ? Math.round(rect.bottom) : null,
           docScrollHeight: document.documentElement.scrollHeight,
         };
       })()`,
    );
    ok =
      typeof layout.rootBottom === "number" &&
      layout.rootBottom <= layout.innerHeight + 1 &&
      layout.docScrollHeight <= layout.innerHeight + 1;
    if (!ok) await sleep(400);
  }
  record(
    "layout: the inset viewport fits without clipping the bottom",
    ok,
    JSON.stringify(layout),
  );
}

async function verifyTray(ctx: VerifyContext): Promise<void> {
  const tray = ctx.tray;
  if (!tray) {
    record("tray: created", false, "no tray instance was created");
    return;
  }
  if (tray.isDestroyed()) {
    record("tray: created", false, "tray was destroyed");
    return;
  }
  const state = tray.getShellState();
  const ok = state.phase === "running" && Boolean(state.serverUrl);
  record(
    "tray: present and reflects the running server",
    ok,
    `phase=${state.phase} server=${state.serverUrl ?? "none"}`,
  );
}

async function verifyAbout(ctx: VerifyContext): Promise<void> {
  const status = currentUpdaterStatus();
  const window = openAboutWindow({
    serverUrl: ctx.serverUrl,
    serverVersion: ctx.serverVersion,
    updateState: status.state,
    updateMessage: status.message,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("About window did not load in 10s")), 10_000);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const text = await window.webContents.executeJavaScript("document.body.innerText");
    const version = app.getVersion();
    const hasVersion = typeof text === "string" && text.includes(version);
    const hasServer = typeof text === "string" && text.includes("Paperclip Server");
    record(
      "about: window renders version and server info",
      hasVersion && hasServer,
      `version=${version} server=${ctx.serverVersion ?? "n/a"}`,
    );
    const chrome = await window.webContents.executeJavaScript(
      `({
         dragbar: Boolean(document.querySelector(".shell-dragbar")),
         paddingTop: getComputedStyle(document.querySelector(".scene")).paddingTop,
         seam: getComputedStyle(document.body, "::after").borderTopWidth,
       })`,
    );
    record(
      "about: uses the same integrated chrome as the main window",
      chrome.dragbar === true && chrome.paddingTop === "62px" && chrome.seam === "0px",
      JSON.stringify(chrome),
    );
    await capture(window, "about-window.png");
  } catch (error) {
    record("about: window renders version and server info", false, String(error));
  } finally {
    currentAboutWindow()?.close();
  }
}

function verifyLogExport(ctx: VerifyContext): void {
  const destination = path.join(os.tmpdir(), `paperclip-verify-${Date.now()}.log`);
  try {
    const result = exportLogs(destination, {
      serverUrl: ctx.serverUrl,
      serverVersion: ctx.serverVersion,
    });
    const exists = existsSync(result.path);
    const content = exists ? readFileSync(result.path, "utf8") : "";
    const ok =
      exists &&
      result.bytes > 0 &&
      content.includes("Paperclip desktop log bundle") &&
      content.includes(`App version: ${app.getVersion()}`);
    record(
      "logs: export bundle written",
      ok,
      `${result.path} (${result.files} files, ${result.bytes} bytes, name=${defaultLogBundleName().slice(0, 21)}…)`,
    );
  } catch (error) {
    record("logs: export bundle written", false, String(error));
  }
}

async function verifyUpdater(): Promise<void> {
  const expected = (process.env.PAPERCLIP_DESKTOP_EXPECT_UPDATE ?? "any").trim();
  const reason = updaterDisabledReason();
  if (reason && expected !== "available") {
    const ok = expected === "disabled" || expected === "any";
    record("updater: channel configured", ok, `disabled: ${reason}`);
    return;
  }
  const status = await checkForUpdates({ timeoutMs: 30_000 });
  const ok =
    expected === "any"
      ? status.state === "available" || status.state === "not-available"
      : status.state === expected;
  record(`updater: check reaches ${expected}`, ok, `state=${status.state} ${status.message}`);
}

/** Run every check; returns the number of failures. */
export async function runVerification(ctx: VerifyContext): Promise<number> {
  process.stdout.write("[verify] starting in-app verification\n");
  // Plugins go first: the checks reload the window, and the shell/layout
  // assertions below then run against the final (translated) UI.
  await verifyPlugins(ctx);
  await verifyFrame(ctx);
  await sleep(600);
  await capture(ctx.window, "main-window.png");
  await verifyTray(ctx);
  await verifyAbout(ctx);
  verifyLogExport(ctx);
  await verifyUpdater();
  const failures = results.filter((entry) => !entry.ok);
  process.stdout.write(
    `[verify] ${results.length - failures.length}/${results.length} checks passed\n`,
  );
  process.stdout.write(`[verify] ${JSON.stringify({ results })}\n`);
  return failures.length;
}
