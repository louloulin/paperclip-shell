import { contextBridge, ipcRenderer, webFrame } from "electron";

// Minimal, additive surface: the Paperclip UI is served by the local server and
// is not modified by this shell, so nothing here is required for it to work.
contextBridge.exposeInMainWorld("paperclipDesktop", {
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node,
  },
  isDesktop: true,
});

/**
 * Desktop plugins (main-world scripts, e.g. the Chinese language pack) are
 * fetched from the main process once per navigation so they install before
 * the app bundle runs. The payload is pure data: the scripts execute with
 * exactly the page's own privileges.
 *
 * Preload runs even earlier than a `document_start` content script — at that
 * point `document.documentElement` does not exist yet, and scripts that touch
 * the DOM on init would throw. Wait for the document element (a microsecond
 * later, still well before any page script), then inject in order.
 */
try {
  const payload = ipcRenderer.sendSync("plugins:renderer-payload", location.href) as
    | { settings?: unknown; scripts?: unknown }
    | null;
  const settings = typeof payload?.settings === "string" ? payload.settings : null;
  const scripts = Array.isArray(payload?.scripts) ? (payload?.scripts as string[]) : [];
  const sources = scripts.filter((source): source is string => typeof source === "string");
  if (settings !== null) {
    const inject = () => {
      // The settings mirror must land before the pack reads it, and the pack's
      // own manifest order matters (the fetch patch installs before the DOM
      // translator), so the chain is awaited rather than fired in parallel.
      const queue = [settings, ...sources];
      let chain = Promise.resolve();
      for (const source of queue) {
        chain = chain
          .then(() => webFrame.executeJavaScript(source))
          .then(() => undefined)
          .catch(() => {
            // A failing plugin must never break page load.
          });
      }
    };
    if (document.documentElement) {
      inject();
    } else {
      const observer = new MutationObserver(() => {
        if (document.documentElement) {
          observer.disconnect();
          inject();
        }
      });
      observer.observe(document, { childList: true });
    }
  }
} catch {
  // Plugins are optional; a missing handler or payload must never break load.
}
