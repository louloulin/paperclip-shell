import { backdropHtml, dragbarHtml, logoHtml, shellCss } from "./theme.js";

export interface PageOptions {
  /** `titleBarStyle: "hiddenInset"`: reserve room for the traffic lights. */
  titleBarInset?: boolean;
}

/**
 * Startup screens rendered in the window before the server is reachable.
 *
 * Kept free of Electron imports so they can be rendered and inspected on their
 * own (see scripts/preview-shell.cjs).
 *
 * Stages advance on real signals from the server log (see STAGE_PATTERNS in
 * main.ts), so a slow first-run migration shows progress instead of a frozen
 * "Starting…" label. `window.__setStage(stage, detail)` is the entire contract.
 */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const STAGES: Array<{ id: string; label: string }> = [
  { id: "env", label: "Preparing environment" },
  { id: "server", label: "Starting local server" },
  { id: "database", label: "Preparing database" },
  { id: "migrate", label: "Applying migrations" },
  { id: "ui", label: "Loading interface" },
];

function stagesHtml(): string {
  return STAGES.map(
    (stage, index) =>
      `      <li data-stage="${stage.id}" style="--i:${index}"><span class="dot"></span><span class="label">${stage.label}</span></li>`,
  ).join("\n");
}

export function loadingPage({ titleBarInset = false }: PageOptions = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Paperclip</title>
<style>
${shellCss({ titleBarInset })}
.card { width: min(432px, calc(100vw - 48px)); padding: 28px 30px 22px; }
.head { display: flex; align-items: center; gap: 16px; }
.heading { min-width: 0; }
h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
  background: linear-gradient(100deg, #fafafa 0%, #d4d4d8 26%, #ffffff 46%, #d4d4d8 66%, #fafafa 100%);
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: sheen 7s ease-in-out infinite;
}
.sub { margin: 2px 0 0; font-size: 12px; color: var(--shell-muted); }
.stages {
  position: relative;
  list-style: none;
  margin: 22px 0 0;
  padding: 0;
  --fill: 0;
}
.stages::before,
.stages::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 15px;
  bottom: 15px;
  width: 1px;
  border-radius: 1px;
}
.stages::before { background: rgba(255, 255, 255, 0.08); }
.stages::after {
  background: linear-gradient(180deg, var(--shell-violet), var(--shell-cyan));
  box-shadow: 0 0 8px rgba(103, 232, 249, 0.6);
  transform: scaleY(var(--fill));
  transform-origin: 50% 0;
  transition: transform 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
.stages li {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 6px 0;
  color: var(--shell-faint);
  font-size: 12.5px;
  opacity: 0;
  animation: row-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(0.32s + var(--i) * 0.06s);
  transition: color 0.35s ease;
}
.stages .dot {
  position: relative;
  z-index: 1;
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 1px solid #3f3f46;
  background: var(--shell-bg);
  box-shadow: 0 0 0 3px var(--shell-bg);
  transition: background 0.35s ease, border-color 0.35s ease, box-shadow 0.35s ease;
}
.stages li.done { color: var(--shell-muted); }
.stages li.done .dot {
  border-color: transparent;
  background: var(--shell-emerald);
  box-shadow: 0 0 0 3px var(--shell-bg), 0 0 10px rgba(52, 211, 153, 0.55);
}
.stages li.active { color: var(--shell-text); }
.stages li.active .dot {
  border-color: transparent;
  background: linear-gradient(135deg, var(--shell-violet), var(--shell-cyan));
  box-shadow: 0 0 0 3px var(--shell-bg), 0 0 14px rgba(103, 232, 249, 0.7);
  animation: pulse 1.25s ease-in-out infinite;
}
.track {
  height: 3px;
  margin-top: 18px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.track .fill {
  display: block;
  height: 100%;
  width: 8%;
  position: relative;
  overflow: hidden;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--shell-violet), var(--shell-cyan));
  box-shadow: 0 0 14px rgba(103, 232, 249, 0.45);
  transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
}
.track .fill::after {
  content: "";
  position: absolute;
  inset: 0;
  width: 45%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.75), transparent);
  transform: translateX(-140%);
  animation: sweep 1.7s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
.foot {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  margin-top: 10px;
  min-height: 16px;
  font-size: 11.5px;
  color: var(--shell-faint);
}
.foot .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot .elapsed { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.hint {
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--shell-muted);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 0.5s ease, transform 0.5s ease;
}
.hint.show { opacity: 1; transform: none; }
</style></head>
<body>
${titleBarInset ? dragbarHtml() : ""}
${backdropHtml("loading")}
<main class="scene">
  <section class="card" role="status" aria-live="polite">
    <div class="head">
      ${logoHtml({ animated: true })}
      <div class="heading">
        <h1>Paperclip</h1>
        <p class="sub">Preparing your local workspace</p>
      </div>
    </div>
    <ul class="stages" id="stages">
${stagesHtml()}
    </ul>
    <div class="track"><span class="fill" id="fill"></span></div>
    <div class="foot"><span class="detail" id="detail"></span><span class="elapsed" id="elapsed"></span></div>
    <div class="hint" id="hint">First launch sets up a local database — this can take a minute.</div>
  </section>
</main>
<script>
  (function () {
    var order = ["env", "server", "database", "migrate", "ui"];
    // Reaching a stage means everything before it finished; the bar never
    // reaches 100% because the UI load itself replaces this document.
    var progress = [8, 26, 52, 78, 94];
    var items = Array.prototype.slice.call(document.querySelectorAll("#stages li"));
    var stages = document.getElementById("stages");
    var fill = document.getElementById("fill");
    var current = -1;

    function paint() {
      for (var i = 0; i < items.length; i++) {
        items[i].className = i < current ? "done" : i === current ? "active" : "";
      }
      var ratio = current <= 0 ? 0 : current / (items.length - 1);
      stages.style.setProperty("--fill", String(ratio));
      fill.style.width = progress[current] + "%";
    }

    function setStage(id, detail) {
      var idx = order.indexOf(id);
      if (idx === -1) return;
      if (idx > current) {
        current = idx;
        paint();
      }
      document.documentElement.setAttribute("data-stage", id);
      if (typeof detail === "string" && detail) {
        document.getElementById("detail").textContent = detail;
      }
    }
    window.__setStage = setStage;
    window.__shellStage = function () { return current >= 0 ? order[current] : null; };
    window.__shellProgress = function () { return current >= 0 ? progress[current] : 0; };

    setStage("env");

    var started = Date.now();
    var elapsed = document.getElementById("elapsed");
    setInterval(function () {
      elapsed.textContent = Math.round((Date.now() - started) / 1000) + "s";
    }, 1000);
    setTimeout(function () { document.getElementById("hint").className = "hint show"; }, 8000);
  })();
</script>
</body></html>`;
}

export function errorPage(
  message: string,
  logsPath: string,
  { titleBarInset = false }: PageOptions = {},
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Paperclip</title>
<style>
${shellCss({ titleBarInset })}
.card {
  width: min(660px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  padding: 26px 28px 22px;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  align-self: flex-start;
  padding: 3px 9px;
  border-radius: 99px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.08);
  color: #fca5a5;
  font-size: 11px;
  letter-spacing: 0.02em;
}
.badge i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #f87171;
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.9);
  animation: pulse 1.6s ease-in-out infinite;
}
h1 { margin: 14px 0 6px; font-size: 17px; font-weight: 600; }
p { margin: 0 0 14px; color: var(--shell-muted); font-size: 12.5px; }
p code {
  color: var(--shell-text);
  font-size: 11.5px;
  word-break: normal;
  overflow-wrap: anywhere;
}
pre {
  flex: 1 1 auto;
  min-height: 90px;
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(9, 9, 11, 0.72);
  color: #d4d4d8;
  font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.foot { margin-top: 14px; display: flex; align-items: center; gap: 8px; color: var(--shell-faint); font-size: 11.5px; }
.foot .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--shell-faint); }
</style></head>
<body>
${titleBarInset ? dragbarHtml() : ""}
${backdropHtml("error")}
<main class="scene">
  <section class="card" role="alert">
    <span class="badge"><i></i>Startup failed</span>
    <h1>Paperclip couldn’t start</h1>
    <p>The local server did not become ready. Full logs are in <code>${escapeHtml(logsPath)}</code>.</p>
    <pre>${escapeHtml(message)}</pre>
    <div class="foot"><span class="dot"></span>Restart the local server from the Paperclip menu after fixing the cause.</div>
  </section>
</main>
</body></html>`;
}
