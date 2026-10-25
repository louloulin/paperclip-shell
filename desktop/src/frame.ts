import type { WebContents } from "electron";
import { DRAGBAR_ID, injectedChromeCss, TITLEBAR_INSET } from "./theme.js";

/**
 * Integrate the served Paperclip UI with the window chrome.
 *
 * On macOS the windows run with `titleBarStyle: "hiddenInset"`: there is no
 * native title bar, so the traffic lights sit over the app itself. We reserve a
 * 30px band at the top and add a transparent drag strip there. There is no
 * border around the viewport — a hairline between the title bar and content
 * reads as a separate frame and is exactly the seam we are removing.
 *
 * The band has a consequence the app cannot know about: it sizes itself with
 * viewport units (`100dvh`, `min-h-dvh`, and a set of `--sz-*` custom
 * properties). Those still describe the FULL window, so every one of them is
 * 30px too tall for the box the app actually lives in, and `body { overflow:
 * clip }` cuts off the bottom of the UI. We therefore rewrite the app's
 * viewport-derived lengths to the reduced viewport.
 *
 * This is runtime-only: CSS is injected through the devtools protocol and one
 * empty element is appended, so the Paperclip source is untouched.
 */

const VIEWPORT_FIX_STYLE_ID = "paperclip-viewport-fix";

/** The app's viewport-height utilities (Tailwind v4 emits exactly these). */
function utilityCss(band: number): string {
  return `
.h-dvh { height: calc(100dvh - ${band}px) !important; }
.min-h-dvh { min-height: calc(100dvh - ${band}px) !important; }
.max-h-dvh { max-height: calc(100dvh - ${band}px) !important; }
.h-svh { height: calc(100svh - ${band}px) !important; }
.min-h-svh { min-height: calc(100svh - ${band}px) !important; }
.max-h-svh { max-height: calc(100svh - ${band}px) !important; }
`;
}

export function installShellFrame(
  contents: WebContents,
  { inset = true }: { inset?: boolean } = {},
): void {
  if (!inset) return;
  const band = TITLEBAR_INSET;

  contents.on("dom-ready", () => {
    void contents.insertCSS(`${injectedChromeCss({ inset })}\n${utilityCss(band)}`).catch(() => {
      // A window can be destroyed mid-navigation; a missing strip is not fatal.
    });
    void contents
      .executeJavaScript(
        `(() => {
           const band = ${band};
           if (document.getElementById(${JSON.stringify(DRAGBAR_ID)})) {
             return "already";
           }
           const strip = document.createElement("div");
           strip.id = ${JSON.stringify(DRAGBAR_ID)};
           strip.setAttribute("aria-hidden", "true");
           document.documentElement.appendChild(strip);
           return "added";
         })()`,
      )
      .catch(() => {
        // The page may be navigating away; the next dom-ready re-applies it.
      });
    void contents
      .executeJavaScript(
        `(() => {
           const band = ${band};
           const adjust = (value) => value.replace(
             /(\\d*\\.?\\d+)(d?vh)\\b/g,
             (match, amount, unit) => {
               const offset = Math.round((Number(amount) / 100) * band * 100) / 100;
               return offset === 0 ? match : "calc(" + amount + unit + " - " + offset + "px)";
             },
           );
           const found = new Map();
           const visit = (rules) => {
             for (const rule of rules) {
               if (rule.cssRules) { visit(rule.cssRules); continue; }
               if (!rule.selectorText) continue;
               if (!/(:root|^html\\b)/.test(rule.selectorText)) continue;
               // cssText keeps custom properties that the indexed item list
               // may omit.
               const pattern = /(--[a-zA-Z0-9_-]+)\\s*:\\s*([^;]+)/g;
               let match;
               while ((match = pattern.exec(rule.style.cssText || "")) !== null) {
                 if (!/\\d(d?vh)\\b/.test(match[2])) continue;
                 found.set(match[1], match[2].trim());
               }
             }
           };
           for (const sheet of Array.from(document.styleSheets)) {
             try { visit(sheet.cssRules); } catch { /* cross-origin sheet */ }
           }
           if (!found.size) return "none";
           let css = ":root{";
           for (const [property, value] of found) {
             css += property + ":" + adjust(value) + ";";
           }
           css += "}";
           let style = document.getElementById(${JSON.stringify(VIEWPORT_FIX_STYLE_ID)});
           if (!style) {
             style = document.createElement("style");
             style.id = ${JSON.stringify(VIEWPORT_FIX_STYLE_ID)};
             document.head.appendChild(style);
           }
           style.textContent = css;
           return "rewrote:" + found.size;
         })()`,
      )
      .catch(() => {
        // The stylesheet may not be readable yet; the next dom-ready retries.
      });
  });
}
