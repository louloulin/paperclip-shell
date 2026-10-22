import type { WebContents } from "electron";
import { DRAGBAR_ID, injectedChromeCss } from "./theme.js";

/**
 * Integrate the served Paperclip UI with the window chrome.
 *
 * On macOS the windows run with `titleBarStyle: "hiddenInset"`: there is no
 * native title bar, so the traffic lights sit over the app itself. We reserve a
 * 30px band at the top and add a transparent drag strip there. There is no
 * border around the viewport — a hairline between the title bar and content
 * reads as a separate frame and is exactly the seam we are removing.
 *
 * This is runtime-only: CSS is injected through the devtools protocol and one
 * empty element is appended, so the Paperclip source is untouched.
 */
export function installShellFrame(
  contents: WebContents,
  { inset = true }: { inset?: boolean } = {},
): void {
  if (!inset) return;
  contents.on("dom-ready", () => {
    void contents.insertCSS(injectedChromeCss({ inset })).catch(() => {
      // A window can be destroyed mid-navigation; a missing strip is not fatal.
    });
    void contents
      .executeJavaScript(
        `(() => {
           if (document.getElementById(${JSON.stringify(DRAGBAR_ID)})) return;
           const strip = document.createElement("div");
           strip.id = ${JSON.stringify(DRAGBAR_ID)};
           strip.setAttribute("aria-hidden", "true");
           document.documentElement.appendChild(strip);
         })()`,
      )
      .catch(() => {
        // The page may be navigating away; the next dom-ready re-applies it.
      });
  });
}
