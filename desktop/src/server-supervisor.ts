import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { serverEntry, serverRoot, dataHome, logsDir, serverLogFile } from "./paths.js";
import { resolveUserPath } from "./user-path.js";

export interface SupervisorOptions {
  /** Fixed port. Default 0 -> let the server pick (detect-port) and report it. */
  port?: number;
  onLog?: (line: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Reported once the shell PATH has been resolved, before the spawn. */
  onEnvResolved?: (info: { pathSource: string; pathEntries: number }) => void;
}

export interface StartedServer {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

const HEALTH_TIMEOUT_MS = Number(process.env.PAPERCLIP_DESKTOP_HEALTH_TIMEOUT_MS ?? 240_000);
const SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_PORT = Number(process.env.PAPERCLIP_DESKTOP_PORT ?? 3187);

function serverEnv(port: number, userPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A Finder-launched app gets a minimal PATH, which hides user-installed
    // agent CLIs (claude, codex, ...) from the server's command resolution.
    PATH: userPath,
    // Never inherit a developer's own Paperclip home / instance.
    PAPERCLIP_HOME: dataHome(),
    PAPERCLIP_INSTANCE_ID: "desktop",
    PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_BIND: "loopback",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    NODE_ENV: "production",
    PORT: String(port),
    // Electron's Node exposes electron-specific version keys; the server only
    // cares about process.versions.node, which is Electron's bundled Node.
    ELECTRON_RUN_AS_NODE: undefined as unknown as string,
  };
}

export async function startServer(options: SupervisorOptions = {}): Promise<StartedServer> {
  const port = options.port ?? DEFAULT_PORT;
  mkdirSync(logsDir(), { recursive: true });
  const logStream: WriteStream = createWriteStream(serverLogFile(), { flags: "a" });

  const standaloneNode = process.env.PAPERCLIP_DESKTOP_NODE_BIN?.trim();
  const command = standaloneNode || process.execPath;
  const userPath = resolveUserPath();
  options.onEnvResolved?.({
    pathSource: userPath.source,
    pathEntries: userPath.value.split(":").filter(Boolean).length,
  });
  const env = serverEnv(port, userPath.value);
  if (standaloneNode) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = "1";

  const child: ChildProcess = spawn(command, [serverEntry()], {
    cwd: serverRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let resolvedPort = port;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  const forward = (chunk: Buffer) => {
    const text = chunk.toString();
    logStream.write(text);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      options.onLog?.(line);
      const match = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
      if (match) resolvedPort = Number(match[1]);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    logStream.end();
    options.onExit?.({ code, signal });
  });

  const stop = async (): Promise<void> => {
    if (exited || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  };

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw new Error(
        `Paperclip server exited before becoming healthy (code=${exited.code} signal=${exited.signal}). ` +
          `See ${serverLogFile()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${resolvedPort}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return { port: resolvedPort, baseUrl: `http://127.0.0.1:${resolvedPort}`, stop };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await stop();
  throw new Error(
    `Paperclip server did not become healthy within ${HEALTH_TIMEOUT_MS}ms` +
      `${lastError ? ` (${(lastError as Error).message})` : ""}. See ${serverLogFile()}`,
  );
}
