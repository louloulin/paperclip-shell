/**
 * Entry point for scripts/preview-shell.cjs: the shell-owned pages, bundled
 * separately so the preview harness can render them without starting a server.
 */
export { loadingPage, errorPage } from "./loading-page.js";
export { aboutHtml } from "./about.js";
