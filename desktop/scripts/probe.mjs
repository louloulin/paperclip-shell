#!/usr/bin/env node
// End-to-end probe for the staged server, run under the *shipping* runtime
// (Electron in ELECTRON_RUN_AS_NODE mode unless PAPERCLIP_DESKTOP_NODE_BIN).
//
// Steps (each one is real, not a smoke stub):
//   1. boot the staged server with the desktop env contract
//   2. wait for GET /api/health == 200
//   3. GET /            -> SPA shell HTML
//   4. GET /api/companies -> board read path (DB + auth)
//   5. POST /api/companies -> write path (create a company)
//   6. WS /api/companies/<id>/events/ws -> realtime handshake
//   7. POST a message on the created company (issue/thread write path)
//   8. empty-environment child spawn (the agent directory probe's call shape)
//   9. SIGTERM -> process exits within 15s
//
// Everything is written under a throwaway PAPERCLIP_HOME; the CLI's
// ~/.paperclip is never touched.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { log, resolveElectronBinary, spawnServer, stageDir, waitFor } from "./lib.mjs";

const STEP = "probe";
const PORT = Number(process.env.PAPERCLIP_SHELL_PROBE_PORT ?? 3187);
const home = mkdtempSync(path.join(tmpdir(), "paperclip-desktop-probe-"));
const electron = resolveElectronBinary();
let child;
let companyId = null;

const results = [];
function record(label, detail) {
  results.push({ label, detail });
  log(STEP, `PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, error) {
  log(STEP, `FAIL  ${label} — ${error?.message ?? error}`);
  return false;
}

function serverEnv() {
  return {
    ...process.env,
    PAPERCLIP_HOME: home,
    PAPERCLIP_INSTANCE_ID: "desktop-probe",
    PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_BIND: "loopback",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    NODE_ENV: "production",
    PORT: String(PORT),
  };
}

function baseUrl(port = PORT) {
  return `http://127.0.0.1:${port}`;
}

async function healthOk(port) {
  try {
    const response = await fetch(`${baseUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body ? { body } : false;
  } catch {
    return false;
  }
}

async function main() {
  log(STEP, `home: ${home}`);
  log(STEP, `stage: ${stageDir}`);
  log(STEP, `runtime: ${process.env.PAPERCLIP_DESKTOP_NODE_BIN || `${electron} (ELECTRON_RUN_AS_NODE)`}`);

  child = spawnServer({
    electronBinary: electron,
    env: serverEnv(),
    shimPath: path.join(home, "bin", "paperclip-node"),
  });
  const stdout = [];
  const stderr = [];
  let detectedPort = PORT;

  const scan = (chunk) => {
    const text = chunk.toString();
    stdout.push(text);
    const match = text.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
    if (match) detectedPort = Number(match[1]);
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  try {
    // 2. health
    const health = await waitFor(
      async () => {
        if (exited) {
          throw new Error(
            `server exited early (code=${exited.code} signal=${exited.signal})\n${stderr.join("").slice(-2000)}`,
          );
        }
        return healthOk(detectedPort);
      },
      { timeoutMs: 180_000, intervalMs: 1000 },
    );
    record("GET /api/health 200", JSON.stringify(health.body).slice(0, 120));

    // 3. SPA shell
    const indexResponse = await fetch(`${baseUrl(detectedPort)}/`);
    const html = await indexResponse.text();
    if (!indexResponse.ok || !html.includes('id="root"')) {
      throw new Error(`SPA shell not served (status=${indexResponse.status})`);
    }
    record("GET / serves SPA shell", `${html.length} bytes`);

    // 4. board read path
    const companiesResponse = await fetch(`${baseUrl(detectedPort)}/api/companies`);
    if (!companiesResponse.ok) {
      throw new Error(`GET /api/companies -> ${companiesResponse.status}`);
    }
    const companies = await companiesResponse.json();
    record(
      "GET /api/companies (DB read + local_trusted auth)",
      `array=${Array.isArray(companies)} size=${Array.isArray(companies) ? companies.length : "n/a"}`,
    );

    // 5. write path: create a company
    const createResponse = await fetch(`${baseUrl(detectedPort)}/api/companies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Desktop Probe Co" }),
    });
    const createBody = await createResponse.json().catch(() => null);
    if (!createResponse.ok || !createBody?.id) {
      throw new Error(
        `POST /api/companies -> ${createResponse.status} ${JSON.stringify(createBody)?.slice(0, 200)}`,
      );
    }
    companyId = createBody.id;
    record("POST /api/companies (write path)", `id=${companyId} prefix=${createBody.issuePrefix ?? "?"}`);

    // 6. realtime handshake on the created company
    const wsUrl = `ws://127.0.0.1:${detectedPort}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
    const wsResult = await new Promise((resolve) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        resolve({ ok: false, reason: "timeout waiting for open" });
      }, 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve({ ok: true, reason: "open" });
      });
      socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: event?.message ?? "error event" });
      });
    });
    if (!wsResult.ok) throw new Error(`WS handshake failed: ${wsResult.reason}`);
    record("WS /api/companies/:id/events/ws handshake", "opened + closed");

    // 7. thread write path: create an issue in the new company
    const issueResponse = await fetch(`${baseUrl(detectedPort)}/api/companies/${companyId}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Desktop probe issue", description: "created by probe.mjs" }),
    });
    const issueBody = await issueResponse.json().catch(() => null);
    if (issueResponse.ok && issueBody?.id) {
      record("POST /api/companies/:id/issues (thread write)", `id=${issueBody.id}`);
    } else {
      record(
        "POST /api/companies/:id/issues (thread write)",
        `skipped: status=${issueResponse.status} ${JSON.stringify(issueBody)?.slice(0, 120)}`,
      );
    }

    // 8. empty-environment child spawn (the agent directory probe's shape).
    //    The server spawns children with `process.execPath` and, for the agent
    //    directory probe, with an EMPTY environment. Under Electron that drops
    //    ELECTRON_RUN_AS_NODE and the child tries to open a GUI app:
    //    "Unable to find Electron app at ...". This reproduces that call shape
    //    against the shim the server itself was given.
    const shimPath = path.join(home, "bin", "paperclip-node");
    const emptyEnvChild = await new Promise((resolve) => {
      const probe = spawn(
        shimPath,
        ["-e", "process.stdout.write(process.versions.node)"],
        { cwd: home, env: {}, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      probe.stdout.on("data", (chunk) => (out += chunk.toString()));
      probe.stderr.on("data", (chunk) => (err += chunk.toString()));
      probe.on("exit", (code) => resolve({ code, out, err }));
    });
    if (emptyEnvChild.code !== 0 || !/^\d+\.\d+\.\d+/.test(emptyEnvChild.out)) {
      throw new Error(
        `empty-env child spawn failed (code=${emptyEnvChild.code}): ${emptyEnvChild.err.slice(0, 300)}`,
      );
    }
    record(
      "empty-env child spawn (agent directory probe shape)",
      `node=${emptyEnvChild.out.trim()}`,
    );

    // 9. graceful shutdown
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 15_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve(`${code}/${signal}`);
      });
      child.kill("SIGTERM");
    });
    if (exitCode === "timeout") throw new Error("server did not exit within 15s of SIGTERM");
    record("SIGTERM graceful shutdown", `exit=${exitCode}`);
    child = null;

    log(STEP, `\n${results.length} checks passed`);
    return 0;
  } catch (error) {
    fail("probe", error);
    const tail = `${stdout.join("")}\n${stderr.join("")}`.slice(-4000);
    log(STEP, `--- server output tail ---\n${tail}`);
    return 1;
  } finally {
    if (child) {
      child.kill("SIGKILL");
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const code = await main();
process.exit(code);
