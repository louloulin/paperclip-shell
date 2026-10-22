import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentAboutWindow, openAboutWindow } from "./about.js";
import { defaultLogBundleName, exportLogs } from "./logs.js";
import { checkForUpdates, currentUpdaterStatus, updaterDisabledReason } from "./updater.js";
import type { ShellTray } from "./tray.js";

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
  serverUrl: string | null;
  serverVersion: string | null;
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}: ${name} — ${detail}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
