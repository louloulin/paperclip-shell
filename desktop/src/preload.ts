import { contextBridge } from "electron";

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
