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
npm run verify                                         # tray / About / log export / update channel (packaged app)
npm run verify:dev                                     # same checks in the unpackaged shell (updater = disabled)
cd ../mobile && npm run doctor
```

`npm run verify` drives the **packaged** app: it starts a local HTTP server that serves a real update
feed (built from the artifacts in `release/`, with the version bumped so the installed app counts as
outdated), points the app at it through `PAPERCLIP_DESKTOP_UPDATE_URL`, and asserts four things inside
the app — the tray exists and reports the running server, the About window renders both versions, the
log bundle is written, and the update check reaches `available`. The app exits with the failure count,
so the script's exit code is the verdict. Set `PAPERCLIP_VERIFY_APP` to verify a different bundle
(e.g. the x64 app under Rosetta).

## Menu bar, About and log export

- **Tray**: the menu-bar icon shows the server state (*starting* / *running on http://…* / *stopped*)
  and carries the maintenance actions (open data folder, open logs folder, export logs, restart the
  server, check for updates, quit). The icon is `build/trayTemplate.png`, generated from
  `build/tray.svg` by `npm run icons` and shipped as an extra resource.
- **About Paperclip**: shows the shell version, the *server* version, the server URL, the Electron /
  Chromium / Node versions, the update state and the data + logs folders.
- **Export logs…**: writes one self-contained text bundle (diagnostics header + every file in the logs
  directory, capped at 5 MB per file) and offers to reveal it.

## Automatic updates

Updates are **off unless a feed is configured** — a self-hosted build must not point at somebody
else's server.

- `PAPERCLIP_DESKTOP_UPDATE_URL=<http(s) url>` selects a generic feed (also embedded into the bundle
  as `app-update.yml` when the packager runs with that variable).
- `npm run package:mac` with that variable set also writes `release/latest-mac.yml` next to the
  artifacts; serve `release/` over HTTP and the app finds the new version.
- macOS updates are applied from the zip artifact (`Paperclip-<version>-<arch>-mac.zip`); the dmg
  remains the artifact a user installs by hand. `autoDownload` is off: an update is only fetched after
  the user says yes.

## Design decisions

- **Reuse Electron's built-in Node** (`ELECTRON_RUN_AS_NODE`) instead of bundling a Node runtime.
  `sharp` is N-API (ABI-stable), `embedded-postgres` is JS + platform binaries, so the only real
  constraint is the Node *version* — enforced by the `preflight` gate, with
  `PAPERCLIP_DESKTOP_NODE_BIN` as a one-line escape hatch.
- **Isolated data directory**: `PAPERCLIP_HOME=<userData>/paperclip`, `PAPERCLIP_INSTANCE_ID=desktop`.
  The CLI's `~/.paperclip` is never touched.
- **No frontend fork**: the server already serves the SPA from `server/ui-dist`
  (`uiMode=static`), so the shell just loads `http://127.0.0.1:<port>`.
- **Login-shell PATH injection**: an app launched from Finder/Dock gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  so the server's command resolution cannot see user-installed agent CLIs (`claude`, `codex`, `node`,
  homebrew/nvm tools) and agents fail with `Command not found in PATH: "claude"`. Before spawning the
  server the shell asks the user's login shell (`$SHELL -ilc`) for its PATH, merges it with the inherited
  PATH and a fallback list of common bin dirs, and passes that to the server. Override with
  `PAPERCLIP_DESKTOP_PATH=/custom/path:...` (used verbatim). The menu's *Restart local server* re-probes.
- **Bundled skills ship with the server**: the server seeds its company skill catalog from
  `<serverRoot>/skills` and `<serverRoot>/skills-releases` (repo root, not `server/`). The staging step
  copies both, otherwise a packaged install has only the `first-task` skill and agent selections fail
  with `Invalid company skill selection (unknown references: paperclipai/...)`.
- **App icon**: `build/icon.svg` is the source; `npm run icons` renders it with Electron and builds
  `build/icon.icns` via `sips` + `iconutil`. `package.mjs` regenerates it when the svg is newer.
- **Startup screen**: the loading page advances through real stages (environment → server → database →
  migrations → interface), driven by server log lines, with an elapsed timer and a slow-first-run hint.
