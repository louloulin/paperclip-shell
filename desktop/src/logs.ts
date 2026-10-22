import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { dataHome, logsDir, serverLogFile } from "./paths.js";

/**
 * Log export (M4).
 *
 * The app writes the server's stdout/stderr to <userData>/logs/server.log. A
 * support report needs more than the file itself: it should also identify the
 * build, the runtime and where the data lives. We therefore produce one
 * self-contained text bundle that can be attached to a bug report, with a tail
 * cap per file so a multi-gigabyte log cannot turn the export into a hang.
 */

const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;

export interface LogBundleResult {
  path: string;
  files: number;
  bytes: number;
}

export interface ExportLogsOptions {
  /** Server version from /api/health, when known. */
  serverVersion?: string | null;
  serverUrl?: string | null;
  now?: Date;
}

function tail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const buffer = readFileSync(file);
  return `[... ${size - maxBytes} bytes truncated ...]\n${buffer.subarray(size - maxBytes).toString("utf8")}`;
}

function diagnostics(options: ExportLogsOptions): string {
  const lines = [
    "Paperclip desktop log bundle",
    `Generated: ${(options.now ?? new Date()).toISOString()}`,
    `App version: ${app.getVersion()}`,
    `Packaged: ${app.isPackaged}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron ?? "n/a"}`,
    `Chrome: ${process.versions.chrome ?? "n/a"}`,
    `Node: ${process.versions.node}`,
    `Data home: ${dataHome()}`,
    `Logs directory: ${logsDir()}`,
    `Server URL: ${options.serverUrl ?? "not running"}`,
    `Server version: ${options.serverVersion ?? "unknown"}`,
  ];
  if (existsSync(serverLogFile())) {
    lines.push(`Server log: ${serverLogFile()}`);
  }
  return lines.join("\n");
}

/**
 * Write one text bundle containing diagnostics plus every file in the logs
 * directory (oldest name first). Returns the size written.
 */
export function exportLogs(destination: string, options: ExportLogsOptions = {}): LogBundleResult {
  const directory = logsDir();
  const names = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];

  const parts: string[] = [diagnostics(options), ""];
  for (const name of names) {
    const file = path.join(directory, name);
    parts.push(`===== ${name} =====`);
    parts.push(tail(file, MAX_BYTES_PER_FILE));
    if (!parts[parts.length - 1].endsWith("\n")) parts.push("");
  }
  if (names.length === 0) parts.push("(no log files were present)");

  writeFileSync(destination, parts.join("\n"), "utf8");
  return {
    path: destination,
    files: names.length,
    bytes: statSync(destination).size,
  };
}

/** Default filename used by the Save dialog. */
export function defaultLogBundleName(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..*$/, "");
  return `paperclip-logs-${stamp}.log`;
}
