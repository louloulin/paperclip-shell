/**
 * Startup screens rendered in the window before the server is reachable.
 *
 * Kept free of Electron imports so they can be rendered and inspected on their
 * own (see scripts/preview-loading.mjs).
 */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Stages advance on real signals from the server log (see STAGE_PATTERNS in
 * main.ts), so a slow first-run migration shows progress instead of a frozen
 * "Starting…" label.
 */
export function loadingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paperclip</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#18181b; color:#e4e4e7; -webkit-user-select:none; user-select:none;
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .box { width:320px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:22px; }
  /* Same paperclip mark as build/icon.svg, with a heavier stroke so it still
     reads at 22px. */
  .mark { width:22px; height:22px; flex:0 0 auto; display:block; }
  .title { font-size:15px; font-weight:600; }
  ul { list-style:none; margin:0; padding:0; }
  li { display:flex; align-items:center; gap:9px; padding:5px 0; color:#52525b;
       transition:color .2s ease; }
  li .dot { width:6px; height:6px; border-radius:50%; background:#3f3f46; flex:0 0 auto;
            transition:background .2s ease; }
  li.done { color:#a1a1aa; }
  li.done .dot { background:#22c55e; }
  li.active { color:#e4e4e7; }
  li.active .dot { background:#e4e4e7; animation:pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.3; transform:scale(.75); } }
  .foot { display:flex; justify-content:space-between; gap:12px; margin-top:16px;
          min-height:16px; font-size:12px; color:#71717a; }
  .foot .detail { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .foot .elapsed { flex:0 0 auto; font-variant-numeric:tabular-nums; }
  .bar { margin-top:12px; height:2px; border-radius:2px; background:#27272a; overflow:hidden; }
  .bar span { display:block; height:100%; width:34%; border-radius:2px;
              background:linear-gradient(90deg,transparent,#a1a1aa,transparent);
              animation:slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { transform:translateX(-120%); } 100% { transform:translateX(400%); } }
  .hint { margin-top:14px; font-size:12px; color:#a1a1aa; opacity:0; transition:opacity .4s ease; }
  .hint.show { opacity:1; }
</style></head>
<body><div class="box">
  <div class="brand">
    <svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true">
      <rect x="64" y="64" width="896" height="896" rx="200" fill="#27272a"/>
      <path d="M 412 306 V 702 a 86 86 0 0 0 172 0 V 274 a 122 122 0 0 0 -244 0 V 750 a 172 172 0 0 0 344 0 V 338"
            fill="none" stroke="#e4e4e7" stroke-width="96"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="title">Paperclip</div>
  </div>
  <ul id="stages">
    <li data-stage="env"><span class="dot"></span>Preparing environment</li>
    <li data-stage="server"><span class="dot"></span>Starting local server</li>
    <li data-stage="database"><span class="dot"></span>Preparing database</li>
    <li data-stage="migrate"><span class="dot"></span>Applying migrations</li>
    <li data-stage="ui"><span class="dot"></span>Loading interface</li>
  </ul>
  <div class="foot"><span class="detail" id="detail"></span><span class="elapsed" id="elapsed"></span></div>
  <div class="bar"><span></span></div>
  <div class="hint" id="hint">First launch sets up a local database — this can take a minute.</div>
</div>
<script>
  (function () {
    var order = ["env", "server", "database", "migrate", "ui"];
    var current = -1;
    function setStage(id, detail) {
      var idx = order.indexOf(id);
      if (idx === -1) return;
      if (idx > current) {
        current = idx;
        var items = document.querySelectorAll("#stages li");
        for (var i = 0; i < items.length; i++) {
          var pos = order.indexOf(items[i].getAttribute("data-stage"));
          items[i].className = pos < idx ? "done" : (pos === idx ? "active" : "");
        }
      }
      if (typeof detail === "string" && detail) {
        document.getElementById("detail").textContent = detail;
      }
    }
    window.__setStage = setStage;
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

export function errorPage(message: string, logsPath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paperclip</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#18181b; color:#e4e4e7; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .box { max-width:640px; padding:32px; }
  h1 { font-size:16px; margin:0 0 8px; }
  pre { white-space:pre-wrap; word-break:break-word; background:#27272a; padding:12px; border-radius:8px;
        font-size:12px; color:#d4d4d8; max-height:280px; overflow:auto; }
  p { color:#a1a1aa; }
</style></head>
<body><div class="box">
  <h1>Paperclip couldn’t start</h1>
  <p>The local server did not become ready. Details below; full logs are in <code>${escapeHtml(logsPath)}</code>.</p>
  <pre>${escapeHtml(message)}</pre>
</div></body></html>`;
}
