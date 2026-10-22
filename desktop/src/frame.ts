import type { WebContents } from "electron";
import { SHELL_FRAME_CSS } from "./theme.js";

/**
 * Give the served Paperclip UI the same 1px edge as the shell-owned screens.
 *
 * This is runtime-only: it injects CSS through the devtools protocol on every
 * navigation, so neither the Paperclip source nor the DOM is modified. If the
 * app is displaying a light theme the neutral hairline stays subtle; if the
 * page sets its own background, that background wins (the ring is additive).
 */
export function installShellFrame(contents: WebContents): void {
  contents.on("dom-ready", () => {
    void contents.insertCSS(SHELL_FRAME_CSS).catch(() => {
      // A window can be destroyed mid-navigation; a missing ring is not fatal.
    });
  });
}
