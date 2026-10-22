#!/usr/bin/env electron
// Generate build/icon.icns from build/icon.svg.
//
//   npm run icons
//
// Runs inside Electron so the SVG is rasterized by the same engine that renders
// the app (no extra image dependency). Electron renders the 1024px master, then
// the standard macOS toolchain (`sips` + `iconutil`) builds the .icns.
//
// This file is CommonJS on purpose: `electron <script>` is most reliable with a
// CJS main entry, and the repo's package.json is `"type": "module"`.

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const buildDir = path.join(desktopRoot, "build");
const svgPath = path.join(buildDir, "icon.svg");
const masterPath = path.join(buildDir, "icon-1024.png");
const iconsetDir = path.join(buildDir, "icon.iconset");
const icnsPath = path.join(buildDir, "icon.icns");
const traySvgPath = path.join(buildDir, "tray.svg");
const trayPath = path.join(buildDir, "trayTemplate.png");
const tray2xPath = path.join(buildDir, "trayTemplate@2x.png");

const MASTER_SIZE = 1024;

/** Every entry `iconutil` expects, and the pixel size it must contain. */
const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function fail(message) {
  process.stderr.write(`[icons] ${message}\n`);
  app.exit(1);
}

/** The icon must keep transparent corners; an opaque capture means the window
 *  composited a background, which would bake a visible square into the icon. */
function assertTransparentCorners(image) {
  const bitmap = image.toBitmap(); // BGRA
  const { width, height } = image.getSize();
  const alphaAt = (x, y) => bitmap[(y * width + x) * 4 + 3];
  const corners = [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)];
  if (corners.some((alpha) => alpha !== 0)) {
    throw new Error(`expected transparent corners, got alpha=${corners.join(",")}`);
  }
}

/**
 * One reusable capture window.
 *
 * Creating a *second* BrowserWindow after destroying the first makes every
 * subsequent data-URL load fail with ERR_FAILED (the renderer is torn down
 * with the window), so the window is created once and reused for every icon.
 */
let captureWindow = null;

function getCaptureWindow(renderSize) {
  if (!captureWindow || captureWindow.isDestroyed()) {
    captureWindow = new BrowserWindow({
      width: renderSize,
      height: renderSize,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: false, backgroundThrottling: false },
    });
  }
  return captureWindow;
}

async function captureSvg(svg, renderSize) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:${renderSize}px;height:${renderSize}px}</style>${svg}`;

  const window = getCaptureWindow(renderSize);
  window.setContentSize(renderSize, renderSize);

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // One extra frame so gradients/anti-aliasing are fully painted.
  await new Promise((resolve) => setTimeout(resolve, 250));
  // capturePage() returns device pixels, so a 2x display yields 2x pixels.
  // That is a welcome supersample — normalize it back to renderSize.
  const captured = await window.webContents.capturePage();
  const image =
    captured.getSize().width === renderSize
      ? captured
      : captured.resize({ width: renderSize, height: renderSize, quality: "best" });
  const size = image.getSize();
  if (size.width !== renderSize || size.height !== renderSize) {
    throw new Error(`unexpected capture size ${size.width}x${size.height} (source ${captured.getSize().width}px)`);
  }
  assertTransparentCorners(image);
  return { image, sourceWidth: captured.getSize().width };
}

async function renderMaster(svg) {
  const { image, sourceWidth } = await captureSvg(svg, MASTER_SIZE);
  writeFileSync(masterPath, image.toPNG());
  process.stdout.write(`[icons] rendered ${sourceWidth}px master -> ${MASTER_SIZE}px\n`);
}

/**
 * macOS template images: black pixels + alpha only, 16pt/32px pairs. The tray
 * uses the bare paperclip (no tile background) so it reads on either menu bar.
 */
async function renderTray(svg) {
  const { image } = await captureSvg(svg, 128);
  const tray = image.resize({ width: 16, height: 16, quality: "best" });
  const tray2x = image.resize({ width: 32, height: 32, quality: "best" });
  writeFileSync(trayPath, tray.toPNG());
  writeFileSync(tray2xPath, tray2x.toPNG());
  process.stdout.write(`[icons] wrote trayTemplate.png (16px) + trayTemplate@2x.png (32px)\n`);
}

function buildIcns() {
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  for (const [name, size] of ICONSET) {
    execFileSync("sips", ["-z", String(size), String(size), masterPath, "--out", path.join(iconsetDir, name)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath], { stdio: ["ignore", "ignore", "pipe"] });
  rmSync(iconsetDir, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  try {
    if (process.platform !== "darwin") {
      throw new Error("icon generation is macOS-only (needs sips + iconutil)");
    }
    if (!existsSync(svgPath)) throw new Error(`missing ${svgPath}`);

    await renderMaster(readFileSync(svgPath, "utf8"));
    buildIcns();

    if (existsSync(traySvgPath)) {
      await renderTray(readFileSync(traySvgPath, "utf8"));
    } else {
      process.stdout.write(`[icons] no ${path.basename(traySvgPath)} — skipping tray icon\n`);
    }

    const bytes = readFileSync(icnsPath).length;
    if (bytes < 10_000) throw new Error(`icon.icns looks too small (${bytes} bytes)`);
    process.stdout.write(`[icons] wrote ${path.relative(desktopRoot, icnsPath)} (${Math.round(bytes / 1024)} KB)\n`);
    app.exit(0);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});
