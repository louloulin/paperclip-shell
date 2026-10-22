#!/usr/bin/env electron
// Render the shell-owned pages and write screenshots to docs/evidence/.
//
//   npm run preview
//
// This exercises the real loading page (including its stage API), the error
// page and the About page without starting a Paperclip server. It also asserts
// the stage/progress state, so a broken animation script fails loudly instead
// of only looking wrong in a screenshot.

const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const desktopRoot = path.resolve(__dirname, "..");
const evidenceDir = path.resolve(desktopRoot, "..", "docs", "evidence");
const WIDTH = 1280;
const HEIGHT = 860;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
let failures = 0;

function check(name, ok, detail) {
  checks += 1;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name} — ${detail}`);
  if (!ok) failures += 1;
}

function makeWindow(width, height) {
  return new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: "#0d0d10",
    webPreferences: { offscreen: false, backgroundThrottling: false, sandbox: true },
  });
}

async function loadHtml(window, html) {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  // data: navigation right after another window tears down can fail once with
  // ERR_FAILED; retrying is cheaper than serialising window lifetimes.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await window.loadURL(url);
      await sleep(200);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(350);
    }
  }
}

async function shot(window, name) {
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const file = path.join(evidenceDir, name);
  writeFileSync(file, image.toPNG());
  check(`preview: ${name} captured`, size.width > 0 && size.height > 0, `${size.width}x${size.height}`);
}

app.whenReady().then(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const pages = await import(
    pathToFileURL(path.join(desktopRoot, "dist", "preview-exports.js")).href
  );

  // One window for every page: creating/destroying windows between data: loads
  // makes navigation intermittently fail with ERR_FAILED, and reusing it keeps
  // the captures comparable.
  const window = makeWindow(WIDTH, HEIGHT);
  const loading = pages.loadingPage();

  // 0. The hidden-inset variant used by the real macOS windows.
  const insetHtml = pages.loadingPage({ titleBarInset: true });
  check(
    "chrome: hidden-inset variant reserves a draggable band",
    insetHtml.includes('class="shell-dragbar"') && insetHtml.includes("padding: 62px"),
    "dragbar + 30px inset present",
  );

  // 1. Loading screen: first stage, then a deep migration stage, then hand-off.
  try {
    await loadHtml(window, loading);
    await sleep(2100); // let the wire draw and the card settle
    const initial = await window.webContents.executeJavaScript(
      `({ stage: window.__shellStage(), progress: window.__shellProgress(),
          active: document.querySelectorAll("#stages li.active").length,
          done: document.querySelectorAll("#stages li.done").length })`,
    );
    check(
      "loading: starts on env with the first dot active",
      initial.stage === "env" && initial.progress === 8 && initial.active === 1 && initial.done === 0,
      JSON.stringify(initial),
    );
    await shot(window, "loading-env.png");

    await window.webContents.executeJavaScript(
      `window.__setStage("migrate", "Applying 353 migrations")`,
    );
    await sleep(1200);
    const migrating = await window.webContents.executeJavaScript(
      `({ stage: window.__shellStage(), progress: window.__shellProgress(),
          active: document.querySelectorAll("#stages li.active").length,
          done: document.querySelectorAll("#stages li.done").length,
          detail: document.getElementById("detail").textContent })`,
    );
    check(
      "loading: stage API advances dots, connector and bar",
      migrating.stage === "migrate" &&
        migrating.progress === 78 &&
        migrating.active === 1 &&
        migrating.done === 3 &&
        migrating.detail === "Applying 353 migrations",
      JSON.stringify(migrating),
    );
    await shot(window, "loading-migrate.png");

    await window.webContents.executeJavaScript(`window.__setStage("ui")`);
    await sleep(1100);
    const handingOff = await window.webContents.executeJavaScript(
      `({ stage: window.__shellStage(), progress: window.__shellProgress(),
          done: document.querySelectorAll("#stages li.done").length })`,
    );
    check(
      "loading: ui stage marks every earlier step done",
      handingOff.stage === "ui" && handingOff.progress === 94 && handingOff.done === 4,
      JSON.stringify(handingOff),
    );
    await shot(window, "loading-ui.png");

    // 2. Reduced motion: the page must be usable with animation turned off.
    //    Media emulation updates the live document, so no reload is needed.
    try {
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await window.webContents.executeJavaScript(`window.__setStage("database")`);
      await sleep(600);
      const reduced = await window.webContents.executeJavaScript(
        `({ stage: window.__shellStage(),
            matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
            particles: getComputedStyle(document.querySelector(".particles")).display })`,
      );
      // The stage cannot move backwards by design, so only the motion-related
      // assertions apply here: emulation is live and the particles are hidden.
      check(
        "loading: reduced motion hides the particle layer",
        reduced.matches && reduced.particles === "none",
        JSON.stringify(reduced),
      );
      await shot(window, "loading-reduced-motion.png");
    } catch (error) {
      check("loading: reduced motion hides the particle layer", false, String(error));
    } finally {
      try {
        window.webContents.debugger.detach();
      } catch {
        // Already detached.
      }
    }

    // 3. Error page.
    await loadHtml(
      window,
      pages.errorPage(
        "Staged Paperclip server not found at /Applications/Paperclip.app/Contents/Resources/server/dist/index.js\n" +
          "Run `npm run stage` in desktop/ first.",
        "/Users/example/Library/Application Support/Paperclip/logs",
      ),
    );
    await sleep(900);
    const errorText = await window.webContents.executeJavaScript("document.body.innerText");
    check(
      "error: page explains the failure and points at the logs",
      errorText.includes("couldn’t start") &&
        errorText.includes("Application Support/Paperclip/logs"),
      `${errorText.length} chars`,
    );
    await shot(window, "shell-error.png");

    // 4. About page (narrower window, same shell surface).
    window.setContentSize(660, 720);
    await loadHtml(
      window,
      pages.aboutHtml({
        serverUrl: "http://127.0.0.1:3187",
        serverVersion: "0.3.1+0.git.5d1b066",
        updateState: "idle",
        updateMessage: "Ready to check",
        shellVersion: "0.3.1",
        titleBarInset: false,
      }),
    );
    await sleep(900);
    const aboutText = await window.webContents.executeJavaScript("document.body.innerText");
    check(
      "about: renders the shell and server versions",
      aboutText.includes("Version 0.3.1") &&
        aboutText.includes("Paperclip Server") &&
        aboutText.includes("0.3.1+0.git.5d1b066"),
      `${aboutText.length} chars`,
    );
    await shot(window, "about.png");
  } catch (error) {
    check("preview: rendered every shell page", false, String(error));
  }

  console.log(`[preview] evidence written to ${path.relative(process.cwd(), evidenceDir)}`);
  console.log(`[preview] ${checks - failures}/${checks} checks passed`);
  app.exit(failures === 0 ? 0 : 1);
});
