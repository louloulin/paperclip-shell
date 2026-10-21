# paperclip-shell

Standalone desktop & mobile clients for [Paperclip](https://github.com/paperclipai/paperclip).

**Independent by construction.** This repository never modifies the Paperclip checkout: it consumes the
monorepo as a *build input* (builds `@paperclipai/ui` / `@paperclipai/server`, then stages a self-contained
server tree with `pnpm deploy`) and ships its own Electron shell / Capacitor app on top.

```
paperclip-shell/
├── desktop/   Electron shell + server supervisor (ELECTRON_RUN_AS_NODE)
└── mobile/    Capacitor app (mode A: remote self-hosted server)
```

## Requirements

- Node.js >= 24.11.0 (matches Paperclip's own runtime requirement)
- A Paperclip checkout. Default location is the sibling directory `../paperclip`;
  override with `PAPERCLIP_REPO=/path/to/paperclip`.

## Desktop quick start

```bash
cd desktop
npm install
PAPERCLIP_REPO=~/pix/paperclip npm run stage       # build ui+server, stage server tree
PAPERCLIP_REPO=~/pix/paperclip npm run preflight   # Electron Node version + native deps gate
PAPERCLIP_REPO=~/pix/paperclip npm run probe       # boot the staged server end-to-end
```

## Desktop packaging

The staged server tree is **arch-specific** (`sharp`, `@embedded-postgres/<platform>` and the agent
runtimes are native binaries), so each architecture needs its own tree:

| Tree | Arch | How to produce |
|---|---|---|
| `.stage/server` | native | `npm run stage` |
| `.stage/server-x64` | Intel | `PAPERCLIP_SHELL_TARGET_ARCH=x64 npm run stage` |

Cross-arch staging works from either host arch because npm is told to fetch the other arch's
binaries (`npm install --cpu=x64 --os=darwin`). The runtime `require()` probe cannot cross-load, so
for a non-native tree `preflight` verifies the Mach-O architecture of `initdb` + `sharp` instead and
defers the load test to the packaged smoke test.

```bash
# native arch only
PAPERCLIP_REPO=~/pix/paperclip npm run package:mac

# both Apple Silicon and Intel (needs both stage trees; ~1.6 GB each)
PAPERCLIP_SHELL_TARGET_ARCH=x64 PAPERCLIP_REPO=~/pix/paperclip npm run stage
PAPERCLIP_REPO=~/pix/paperclip npm run package:mac:both
```

Re-staging a tree you already installed is cheap — reuse the expensive closure with
`PAPERCLIP_SHELL_SKIP_INSTALL=1` (plus `PAPERCLIP_SHELL_SKIP_BUILD=1 PAPERCLIP_SHELL_SKIP_PACK=1`
to also reuse the built outputs and packed tarballs).

## Mobile quick start (mode A: self-hosted server)

```bash
cd mobile
npm install
PAPERCLIP_MOBILE_SERVER_URL=https://paperclip.example.com npm run sync   # bake in the server address
npm run add:ios && npm run add:android                                   # once, creates the native projects
npm run doctor                                                           # config/plugin/platform checks
```

Without `PAPERCLIP_MOBILE_SERVER_URL` the bundled `www/` page is a connect screen: it stores the
address the user enters and navigates there. Either way the app ends up same-origin with the server,
so the existing Paperclip UI works untouched (cookies, WebSocket live events, service worker).

## Verification

```bash
cd desktop && npm run preflight && npm run probe      # runtime gate + 7 end-to-end checks
PAPERCLIP_DESKTOP_SMOKE=1 npm run dev                 # boots the window, asserts the UI mounted, exits
cd ../mobile && npm run doctor
```

## Design decisions

- **Reuse Electron's built-in Node** (`ELECTRON_RUN_AS_NODE`) instead of bundling a Node runtime.
  `sharp` is N-API (ABI-stable), `embedded-postgres` is JS + platform binaries, so the only real
  constraint is the Node *version* — enforced by the `preflight` gate, with
  `PAPERCLIP_DESKTOP_NODE_BIN` as a one-line escape hatch.
- **Isolated data directory**: `PAPERCLIP_HOME=<userData>/paperclip`, `PAPERCLIP_INSTANCE_ID=desktop`.
  The CLI's `~/.paperclip` is never touched.
- **No frontend fork**: the server already serves the SPA from `server/ui-dist`
  (`uiMode=static`), so the shell just loads `http://127.0.0.1:<port>`.
