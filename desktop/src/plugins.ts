/**
 * Desktop plugin support.
 *
 * A plugin is a directory under <userData>/plugins/<id> holding a plugin.json
 * manifest plus the script files it references. The shell ships a small
 * catalog of bundled plugins (staged from their own repositories at build
 * time into Resources/plugins); installing one copies it into the user
 * plugins directory, which is where user-visible state lives.
 *
 * Injection model mirrors the plugins' own proxy/extension semantics: scripts
 * run in the page's MAIN world at document start, in manifest order, on the
 * origins listed in matchOrigins. The sandboxed preload asks this (main)
 * process for the payload once per navigation via synchronous IPC, so the
 * scripts install before the app bundle executes. The payload is pure data —
 * even a tampered plugin directory can only run code with the page's own
 * (web) privileges.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundledPluginsDir, pluginsDir } from "./paths.js";

/** Reply language the pack asks the agent to use; mirrors the pack's popup. */
export type AgentLanguage = "auto" | "zh-CN" | "en" | "off";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Script files relative to the plugin dir, executed in order at document start. */
  scripts: string[];
  /** Scripts run only on page origins that start with one of these prefixes. */
  matchOrigins: string[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
}

interface PluginsState {
  disabled: Record<string, boolean>;
  agentLanguage: AgentLanguage;
}

export const DEFAULT_AGENT_LANGUAGE: AgentLanguage = "auto";

const DEFAULT_STATE: PluginsState = { disabled: {}, agentLanguage: DEFAULT_AGENT_LANGUAGE };
let stateCache: PluginsState | null = null;

function log(message: string): void {
  process.stdout.write(`[plugins] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function readManifest(dir: string): PluginManifest | null {
  const file = path.join(dir, "plugin.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PluginManifest>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return null;
    if (!Array.isArray(raw.scripts) || raw.scripts.length === 0) return null;
    if (!Array.isArray(raw.matchOrigins) || raw.matchOrigins.length === 0) return null;
    if (!raw.scripts.every((s) => typeof s === "string") || !raw.matchOrigins.every((s) => typeof s === "string")) {
      return null;
    }
    return {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : raw.id,
      version: typeof raw.version === "string" ? raw.version : "0.0.0",
      description: typeof raw.description === "string" ? raw.description : undefined,
      scripts: raw.scripts,
      matchOrigins: raw.matchOrigins,
    };
  } catch {
    return null;
  }
}

/** Bundled catalog (Resources/plugins): available for one-click install. */
export function listBundled(): PluginManifest[] {
  const root = bundledPluginsDir();
  if (!existsSync(root)) return [];
  const found: PluginManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(path.join(root, entry.name));
    if (manifest) found.push(manifest);
  }
  return found;
}

/** Plugins installed into the user profile, with their enabled state. */
export function listInstalled(): InstalledPlugin[] {
  const root = pluginsDir();
  if (!existsSync(root)) return [];
  const state = loadState();
  const found: InstalledPlugin[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readManifest(dir);
    if (manifest) found.push({ manifest, dir, enabled: !state.disabled[manifest.id] });
  }
  return found;
}

export function isBundled(id: string): boolean {
  return listBundled().some((plugin) => plugin.id === id);
}

export function isInstalled(id: string): boolean {
  return listInstalled().some((plugin) => plugin.manifest.id === id);
}

export function isEnabled(id: string): boolean {
  return !loadState().disabled[id];
}

/** Install (or re-install/update) a bundled plugin into the user profile. */
export function installBundled(id: string): InstalledPlugin | null {
  const bundled = listBundled().find((plugin) => plugin.id === id);
  if (!bundled) {
    log(`cannot install ${id}: not in the bundled catalog (${bundledPluginsDir()})`);
    return null;
  }
  const source = path.join(bundledPluginsDir(), id);
  const target = path.join(pluginsDir(), id);
  mkdirSync(pluginsDir(), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  copyDir(source, target);
  log(`installed ${id}@${bundled.version} -> ${target}`);
  return { manifest: bundled, dir: target, enabled: !loadState().disabled[id] };
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else copyFileSync(source, target);
  }
}

// ---------------------------------------------------------------------------
// State (enable/disable + pack settings the shell owns)
// ---------------------------------------------------------------------------

function stateFile(): string {
  return path.join(pluginsDir(), "plugins-state.json");
}

function loadState(): PluginsState {
  if (stateCache) return stateCache;
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<PluginsState>;
    stateCache = {
      disabled: raw.disabled && typeof raw.disabled === "object" ? raw.disabled : {},
      agentLanguage: isAgentLanguage(raw.agentLanguage) ? raw.agentLanguage : DEFAULT_AGENT_LANGUAGE,
    };
  } catch {
    stateCache = { ...DEFAULT_STATE, disabled: {} };
  }
  return stateCache;
}

function isAgentLanguage(value: unknown): value is AgentLanguage {
  return value === "auto" || value === "zh-CN" || value === "en" || value === "off";
}

function saveState(): void {
  if (!stateCache) return;
  mkdirSync(pluginsDir(), { recursive: true });
  writeFileSync(stateFile(), `${JSON.stringify(stateCache, null, 2)}\n`, "utf8");
}

export function setEnabled(id: string, enabled: boolean): void {
  const state = loadState();
  if (enabled) delete state.disabled[id];
  else state.disabled[id] = true;
  saveState();
}

export function currentAgentLanguage(): AgentLanguage {
  return loadState().agentLanguage;
}

export function setAgentLanguage(value: AgentLanguage): void {
  loadState().agentLanguage = value;
  saveState();
}

/**
 * The pack settings the shell writes into the page's localStorage mirror
 * (the same key the pack's popup and proxy mode use). Derived from the shell
 * state so the menu stays the single source of truth.
 */
export function packSettings(): { enabled: boolean; override: "zh-CN" | "en"; agentLanguage: AgentLanguage } {
  const zhPack = isInstalled("paperclip-zh-pack") && isEnabled("paperclip-zh-pack");
  return {
    enabled: zhPack,
    override: zhPack ? "zh-CN" : "en",
    agentLanguage: currentAgentLanguage(),
  };
}

// ---------------------------------------------------------------------------
// Renderer payload
// ---------------------------------------------------------------------------

// Scripts are tiny (a few hundred KB) and read once per navigation; a small
// mtime-keyed cache avoids re-reading them on every SPA navigation.
const scriptCache = new Map<string, { mtimeMs: number; source: string }>();

function readScript(file: string): string | null {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const cached = scriptCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.source;
    const source = readFileSync(file, "utf8");
    scriptCache.set(file, { mtimeMs, source });
    return source;
  } catch (error) {
    log(`cannot read script ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The settings bootstrap the preload runs before any plugin script.
 *
 * The pack reads its state from a localStorage mirror, and localStorage is
 * keyed by origin *including the port*. The desktop server may come up on a
 * different port after a restart, and a cleared profile has no mirror at all —
 * in both cases the pack would fall back to its own default (`override:
 * "auto"`), which resolves against `navigator.language` and silently leaves an
 * English-locale user with an untranslated UI even though the pack is enabled.
 * Writing the mirror on every navigation keeps this menu the single source of
 * truth and makes the port irrelevant.
 */
function settingsBootstrap(): string {
  const settings = packSettings();
  const json = JSON.stringify(JSON.stringify(settings));
  return `try { window.localStorage.setItem("paperclip-zh-pack.settings", ${json}); } catch (error) {}`;
}

/**
 * Main-world scripts to run for this URL, in injection order. Called from the
 * preload over synchronous IPC exactly once per navigation.
 *
 * `settings` is always present: it is the bootstrap above, not a plugin, so it
 * must run before the first pack script even when no file was readable.
 */
export function rendererPayload(href: string): { settings: string; scripts: string[] } {
  const scripts: string[] = [];
  let origin = "";
  try {
    origin = new URL(href).origin;
  } catch {
    return { settings: settingsBootstrap(), scripts };
  }
  for (const plugin of listInstalled()) {
    if (!plugin.enabled) continue;
    if (!plugin.manifest.matchOrigins.some((prefix) => origin.startsWith(prefix))) continue;
    for (const script of plugin.manifest.scripts) {
      const source = readScript(path.join(plugin.dir, script));
      if (source !== null) scripts.push(source);
    }
  }
  return { settings: settingsBootstrap(), scripts };
}
