/**
 * Shell visual language.
 *
 * Shared by every surface the shell owns (loading, error, About) and injected
 * into the served Paperclip UI as a single 1px edge (see frame.ts), so all
 * windows read as one application instead of "a web page in a window".
 *
 * Everything here is inline CSS/HTML: the loading and About screens are loaded
 * from `data:` URLs, so there are no assets to fetch and no fonts to download.
 */

export const SHELL_BG = "#18181b";
export const SHELL_BG_DEEP = "#0d0d10";

/** The mark used by build/icon.svg and the tray. */
export const PAPERCLIP_PATH =
  "M 412 306 V 702 a 86 86 0 0 0 172 0 V 274 a 122 122 0 0 0 -244 0 V 750 a 172 172 0 0 0 344 0 V 338";

/**
 * The same hairline ring around the content viewport in every window. Injected
 * into the served UI with `webContents.insertCSS` (no DOM or source changes).
 */
export const SHELL_FRAME_CSS = `
html { background-color: ${SHELL_BG}; }
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  border: 1px solid rgba(255, 255, 255, 0.075);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.055);
}
`;

/** Shared tokens, reset, animated backdrop and the unified edge. */
export function shellCss(): string {
  return `
:root {
  color-scheme: dark;
  --shell-bg: ${SHELL_BG};
  --shell-deep: ${SHELL_BG_DEEP};
  --shell-text: #e4e4e7;
  --shell-muted: #a1a1aa;
  --shell-faint: #52525b;
  --shell-border: rgba(255, 255, 255, 0.09);
  --shell-violet: #a78bfa;
  --shell-cyan: #67e8f9;
  --shell-emerald: #34d399;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--shell-deep);
  color: var(--shell-text);
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
/* Unified edge: byte-identical to SHELL_FRAME_CSS. */
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  border: 1px solid rgba(255, 255, 255, 0.075);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.055);
}
.scene {
  position: relative;
  z-index: 2;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.aurora {
  position: fixed;
  inset: -25%;
  z-index: 0;
  pointer-events: none;
  filter: blur(80px);
  opacity: 0.72;
}
.aurora span {
  position: absolute;
  width: 44vmax;
  height: 44vmax;
  border-radius: 50%;
  will-change: transform;
}
.aurora .b1 {
  left: 2%; top: -4%;
  background: radial-gradient(circle at 50% 50%, rgba(167, 139, 250, 0.50), transparent 62%);
  animation: drift-a 26s ease-in-out infinite alternate;
}
.aurora .b2 {
  right: -2%; bottom: -10%;
  background: radial-gradient(circle at 50% 50%, rgba(103, 232, 249, 0.38), transparent 62%);
  animation: drift-b 32s ease-in-out infinite alternate;
}
.aurora .b3 {
  left: 28%; bottom: 2%;
  background: radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.18), transparent 60%);
  animation: drift-c 22s ease-in-out infinite alternate;
}
.aurora.error .b1 { background: radial-gradient(circle at 50% 50%, rgba(248, 113, 113, 0.30), transparent 62%); }
.aurora.error .b2 { background: radial-gradient(circle at 50% 50%, rgba(251, 191, 36, 0.16), transparent 62%); }
.grid {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.5;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 54px 54px;
  -webkit-mask-image: radial-gradient(ellipse 72% 64% at 50% 44%, #000 0%, transparent 100%);
  mask-image: radial-gradient(ellipse 72% 64% at 50% 44%, #000 0%, transparent 100%);
}
.vignette {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: radial-gradient(
    ellipse at 50% 40%,
    transparent 30%,
    rgba(8, 8, 10, 0.55) 78%,
    rgba(8, 8, 10, 0.88) 100%
  );
}
.particles { position: fixed; inset: 0; z-index: 1; pointer-events: none; }
.particles span {
  position: absolute;
  left: var(--x);
  top: var(--y);
  width: var(--s);
  height: var(--s);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.35);
  opacity: 0.35;
  animation: float var(--d) ease-in-out var(--delay) infinite alternate;
}
@keyframes drift-a { to { transform: translate3d(9%, 7%, 0) scale(1.12); } }
@keyframes drift-b { to { transform: translate3d(-8%, -6%, 0) scale(1.08); } }
@keyframes drift-c { to { transform: translate3d(5%, -8%, 0) scale(1.16); } }
@keyframes float {
  from { transform: translate3d(0, 0, 0); opacity: 0.18; }
  to { transform: translate3d(6px, -18px, 0); opacity: 0.55; }
}
@keyframes spin { to { transform: rotate(1turn); } }
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.8); opacity: 0.62; }
}
@keyframes rise {
  from { opacity: 0; transform: translateY(16px) scale(0.985); filter: blur(6px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes row-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes sheen {
  0%, 68% { background-position: 140% 0; }
  100% { background-position: -40% 0; }
}
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes glint {
  0%, 55% { transform: translateX(-130%); }
  80%, 100% { transform: translateX(130%); }
}
@keyframes sweep { to { transform: translateX(320%); } }

.logo { position: relative; width: 64px; height: 64px; flex: 0 0 auto; }
.logo .halo {
  position: absolute;
  inset: -8px;
  border-radius: 22px;
  padding: 1.5px;
  /* A full faint ring plus a bright arc, so the rotation reads as a light
     travelling around the tile rather than a stray line. */
  background: conic-gradient(
    from 0deg,
    rgba(255, 255, 255, 0.12) 0deg,
    rgba(255, 255, 255, 0.05) 120deg,
    rgba(167, 139, 250, 0.55) 238deg,
    rgba(103, 232, 249, 0.95) 296deg,
    rgba(255, 255, 255, 0.12) 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: spin 3.8s linear infinite;
  opacity: 0.9;
}
.logo .tile {
  position: absolute;
  inset: 0;
  border-radius: 18px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: linear-gradient(160deg, #3f3f46, #1f1f23);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    0 20px 50px -16px rgba(0, 0, 0, 0.9);
}
.logo .tile::after {
  content: "";
  position: absolute;
  inset: -40%;
  background: linear-gradient(115deg, transparent 40%, rgba(255, 255, 255, 0.18) 50%, transparent 60%);
  transform: translateX(-130%);
  animation: glint 4.6s ease-in-out infinite;
}
.logo svg {
  position: relative;
  z-index: 1;
  width: 34px;
  height: 34px;
  filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.25));
}
.logo .wire {
  stroke-dasharray: 100;
  stroke-dashoffset: 100;
  animation: draw 1.7s cubic-bezier(0.65, 0, 0.35, 1) 0.18s forwards;
}
.logo .orbit {
  position: absolute;
  inset: -16px;
  animation: spin 9s linear infinite;
}
.logo .orbit::before,
.logo .orbit::after {
  content: "";
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #e4e4e7;
  box-shadow: 0 0 8px rgba(103, 232, 249, 0.9);
  left: calc(50% - 2px);
}
.logo .orbit::before { top: 3px; }
.logo .orbit::after { bottom: 3px; opacity: 0.55; }
.logo.static .wire { animation: none; stroke-dashoffset: 0; }
.logo.static .halo { animation-duration: 9s; opacity: 0.65; }

.card {
  position: relative;
  z-index: 2;
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(24, 24, 27, 0.88), rgba(17, 17, 20, 0.84));
  backdrop-filter: blur(22px) saturate(130%);
  -webkit-backdrop-filter: blur(22px) saturate(130%);
  box-shadow:
    0 30px 80px -28px rgba(0, 0, 0, 0.92),
    0 2px 10px rgba(0, 0, 0, 0.35);
  animation: rise 0.85s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  pointer-events: none;
  background: linear-gradient(
    150deg,
    rgba(255, 255, 255, 0.20),
    rgba(255, 255, 255, 0.03) 34%,
    rgba(167, 139, 250, 0.32) 62%,
    rgba(103, 232, 249, 0.20) 82%,
    rgba(255, 255, 255, 0.06)
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
  .particles, .logo .orbit { display: none; }
}
`;
}

/** Deterministic floating specks; no Math.random so screenshots are stable. */
export function particlesHtml(count = 14): string {
  const specks = Array.from({ length: count }, (_, index) => {
    const x = (index * 37 + 13) % 100;
    const y = (index * 53 + 7) % 96;
    const size = 1 + (index % 3);
    const duration = 9 + (index % 7);
    const delay = -((index * 0.7) % 6);
    return `<span style="--x:${x}%;--y:${y}%;--s:${size}px;--d:${duration}s;--delay:${delay}s"></span>`;
  }).join("");
  return `<div class="particles" aria-hidden="true">${specks}</div>`;
}

export function backdropHtml(variant: "loading" | "error" | "about" = "loading"): string {
  const errorClass = variant === "error" ? " error" : "";
  return `<div class="aurora${errorClass}" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
<div class="grid" aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>
${particlesHtml(variant === "about" ? 9 : 14)}`;
}

/** The paperclip mark. `animated` draws the wire and spins the halo. */
export function logoHtml({ animated = true } = {}): string {
  return `<div class="logo${animated ? "" : " static"}" aria-hidden="true">
  <span class="halo"></span>
  ${animated ? '<span class="orbit"></span>' : ""}
  <span class="tile">
    <svg viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="shell-wire" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="1" stop-color="#d4d4d8"/>
        </linearGradient>
      </defs>
      <path class="wire" pathLength="100" d="${PAPERCLIP_PATH}" fill="none"
            stroke="url(#shell-wire)" stroke-width="72"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>
</div>`;
}
