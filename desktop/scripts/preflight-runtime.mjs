#!/usr/bin/env node
// Preflight gate: prove the runtime we intend to ship can actually run the
// staged server before we spend time packaging.
//
//  1. Electron's built-in Node version >= Paperclip's MINIMUM_NODE_VERSION
//  2. Native deps (sharp, embedded-postgres) load under that runtime
//  3. Staged tree is present (see stage-server.mjs)
//
// Exit code 1 on any failure. Set PAPERCLIP_DESKTOP_ALLOW_OLD_NODE=1 to warn
// instead of failing on the version check (not recommended).

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  capture,
  compareNodeVersions,
  log,
  MINIMUM_NODE_VERSION,
  resolveElectronBinary,
  resolvePaperclipRepo,
  stageDirFor,
} from "./lib.mjs";

const STEP = "preflight";
const failures = [];

// Which staged tree to gate. Cross-arch trees cannot be loaded by the host
// Electron binary (sharp/postgres binaries are single-arch), so their runtime
// probe is replaced by a binary-architecture check and deferred to the
// packaged smoke test.
const targetArch = process.env.PAPERCLIP_SHELL_TARGET_ARCH?.trim() || process.arch;
const crossArch = targetArch !== process.arch;
const stageDir = stageDirFor(targetArch);
// `file(1)` names for the arches we ship.
const FILE_ARCH = { x64: "x86_64", arm64: "arm64" }[targetArch] ?? targetArch;

function check(label, fn) {
  try {
    const detail = fn();
    log(STEP, `PASS  ${label}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (error) {
    const message = error?.message ?? String(error);
    failures.push(`${label}: ${message}`);
    log(STEP, `FAIL  ${label} — ${message}`);
    return false;
  }
}

const repo = resolvePaperclipRepo();
const electron = resolveElectronBinary();
log(STEP, `electron: ${electron}`);

// --- 1. Node version of the runtime we will spawn -------------------------
const nodeVersion = capture(electron, ["-p", "process.versions.node"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
check(
  `runtime Node >= ${MINIMUM_NODE_VERSION}`,
  () => {
    if (compareNodeVersions(nodeVersion, MINIMUM_NODE_VERSION) < 0) {
      if (process.env.PAPERCLIP_DESKTOP_ALLOW_OLD_NODE === "1") {
        return `WARN ${nodeVersion} < ${MINIMUM_NODE_VERSION} (allowed by PAPERCLIP_DESKTOP_ALLOW_OLD_NODE)`;
      }
      throw new Error(
        `runtime Node is ${nodeVersion}, Paperclip requires >= ${MINIMUM_NODE_VERSION}. ` +
          `Set PAPERCLIP_DESKTOP_NODE_BIN to a standalone Node ${MINIMUM_NODE_VERSION}+ runtime.`,
      );
    }
    return `v${nodeVersion}`;
  },
);

// --- 2. Staged server tree ------------------------------------------------
check("staged server tree", () => {
  const entry = path.join(stageDir, "dist", "index.js");
  if (!existsSync(entry)) throw new Error(`missing ${entry}; run \`npm run stage\` first`);
  return stageDir;
});

// --- 3. Native + critical deps load under the shipping runtime ------------
if (crossArch) {
  check(`native deps match target arch (${targetArch})`, () => {
    const verified = [];
    const assertArch = (file, label) => {
      const out = capture("file", ["-b", file]);
      if (!out.includes(FILE_ARCH)) {
        throw new Error(`${label} is not ${targetArch}: ${out.trim()}`);
      }
      verified.push(label);
    };
    const postgresBin = path.join(
      stageDir,
      "node_modules",
      "@embedded-postgres",
      `${process.platform}-${targetArch}`,
      "native",
      "bin",
      "initdb",
    );
    if (!existsSync(postgresBin)) throw new Error(`missing ${postgresBin}`);
    assertArch(postgresBin, "initdb");

    const sharpLibDir = path.join(stageDir, "node_modules", "@img", `sharp-${process.platform}-${targetArch}`, "lib");
    if (!existsSync(sharpLibDir)) throw new Error(`missing ${sharpLibDir}`);
    const sharpNodes = readdirSync(sharpLibDir).filter((f) => f.endsWith(".node"));
    if (sharpNodes.length === 0) throw new Error(`no sharp binding in ${sharpLibDir}`);
    assertArch(path.join(sharpLibDir, sharpNodes[0]), "sharp");

    return verified.join(", ");
  });
  log(
    STEP,
    `cross-arch (${targetArch} on ${process.arch}): require() probe deferred to the packaged smoke test`,
  );
} else if (existsSync(path.join(stageDir, "dist", "index.js"))) {
  const probeScript = `
const { createRequire } = require("node:module");
const req = createRequire(process.argv[1]);
const loaded = [];
for (const name of ["sharp", "embedded-postgres", "express", "ws", "better-auth", "drizzle-orm"]) {
  req(name);
  loaded.push(name);
}
process.stdout.write(JSON.stringify({ ok: true, loaded }));
`;
  check("critical deps require() under shipping runtime", () => {
    const out = capture(
      electron,
      [
        "-e",
        probeScript,
        path.join(stageDir, "package.json"),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        cwd: stageDir,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    if (!parsed.ok) throw new Error("require() probe reported failure");
    return `${parsed.loaded.length} modules`;
  });

  check("sharp native binding loads (libvips)", () => {
    const out = capture(
      electron,
      [
        "-e",
        `const { createRequire } = require("node:module");
const sharp = createRequire(process.argv[1])("sharp");
process.stdout.write(JSON.stringify({ vips: sharp.versions?.vips ?? null, sharp: sharp.versions?.sharp ?? null }));`,
        path.join(stageDir, "package.json"),
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, cwd: stageDir },
    );
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    if (!parsed.vips) throw new Error("sharp loaded but reported no libvips version");
    return `libvips ${parsed.vips}`;
  });
}

// --- 4. Report the runtime identity we will record in the build ----------
const versions = JSON.parse(
  capture(electron, ["-p", "JSON.stringify(process.versions)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }),
);

log(
  STEP,
  `runtime identity: node ${versions.node} | v8 ${versions.v8} | electron ${versions.electron ?? "n/a"}` +
    (crossArch ? ` (host ${process.arch}; target tree is ${targetArch})` : ""),
);

if (failures.length > 0) {
  log(STEP, `${failures.length} check(s) failed`);
  process.exit(1);
}
log(STEP, "all checks passed");
