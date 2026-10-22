import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the PATH the user actually has in their terminal.
 *
 * An app launched from Finder/Dock does not inherit the shell environment:
 * macOS hands it a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). The Paperclip
 * server spawns agent CLIs by searching `env.PATH`, so `claude`, `codex`, `node`
 * and friends resolve to "Command not found in PATH" even though the user has
 * them installed.
 *
 * We ask the user's login shell once, then merge the result with the inherited
 * PATH and a small set of well-known directories.
 */

/** Explicit override: used verbatim, no shell probing. */
const OVERRIDE_ENV = "PAPERCLIP_DESKTOP_PATH";
/** Give up on a slow/blocking shell rc; the fallback list still applies. */
const PROBE_TIMEOUT_MS = 5_000;
const MARKER_START = "__PAPERCLIP_PATH__";
const MARKER_END = "__PAPERCLIP_PATH_END__";

/** Directories that hold user-installed CLIs on a typical macOS/Linux box. */
function fallbackDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/**
 * Ask the login shell for its PATH.
 *
 * `-i` is required for zsh users who set PATH in `.zshrc`; `-l` picks up
 * `.zprofile`/`.profile`. rc files may print banners, so the value is wrapped in
 * markers and extracted from stdout rather than parsed line-by-line.
 */
function probeLoginShell(): string | null {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  if (!existsSync(shell)) return null;

  const result = spawnSync(
    shell,
    ["-ilc", `printf '%s%s%s' '${MARKER_START}' "$PATH" '${MARKER_END}'`],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.error || typeof result.stdout !== "string") return null;

  const start = result.stdout.lastIndexOf(MARKER_START);
  if (start === -1) return null;
  const end = result.stdout.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1) return null;

  const value = result.stdout.slice(start + MARKER_START.length, end).trim();
  return value.length > 0 ? value : null;
}

/** Split, drop blanks, and de-duplicate while preserving first-seen order. */
function normalize(value: string, delimiter: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of value.split(delimiter)) {
    const dir = raw.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    entries.push(dir);
  }
  return entries;
}

export interface ResolvedPath {
  /** The value to hand to the server as PATH. */
  value: string;
  /** Where it came from, for logging. */
  source: "override" | "login-shell" | "fallback";
  /** The login-shell probe result, if it succeeded. */
  shellPath: string | null;
}

let cached: ResolvedPath | null = null;

/** Forget the cached value so the next resolve re-probes (used on server restart). */
export function clearUserPathCache(): void {
  cached = null;
}

export function resolveUserPath(): ResolvedPath {
  if (cached) return cached;

  const override = process.env[OVERRIDE_ENV]?.trim();
  if (override) {
    cached = { value: override, source: "override", shellPath: null };
    return cached;
  }

  // Windows inherits a usable PATH from Explorer and has no `-ilc` login shell.
  if (process.platform === "win32") {
    cached = { value: process.env.PATH ?? "", source: "fallback", shellPath: null };
    return cached;
  }

  const shellPath = probeLoginShell();
  const delimiter = ":";
  const merged = [
    ...normalize(shellPath ?? "", delimiter),
    ...normalize(process.env.PATH ?? "", delimiter),
    ...fallbackDirs(),
  ];
  // Keep only directories that exist so a stale rc entry cannot slow every lookup.
  const dirs = merged.filter((dir) => dir.startsWith("/") && existsSync(dir));
  cached = {
    value: (dirs.length > 0 ? dirs : fallbackDirs()).join(delimiter),
    source: shellPath ? "login-shell" : "fallback",
    shellPath,
  };
  return cached;
}
