---
name: runtime-launchd-service
description: "The local gantry runtime is a launchd service (com.gantry) — restart via launchctl, never npm-start/pkill"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

On this machine the gantry runtime runs as a **launchd LaunchAgent `com.gantry`**
(`~/Library/LaunchAgents/com.gantry.plist`): a single supervised process with
`KeepAlive`, `RunAtLoad`, `GANTRY_HOME=/Users/ravikiranvemula/gantry`, running
`sh -lc 'node dist/postgres-migrate.js && exec node dist/index.js'`. Logs go to
`~/gantry/logs/gantry.log`. GANTRY_HOME is `~/gantry` (NOT `~/.gstack` — that's a
different tool's dir); DB is `gantry` schema in the `gantry` Postgres DB (docker
`gantry-postgres`, tables live in the `gantry` schema, not `public`).

**Why:** I wasted a long stretch fighting this. `pkill`-ing the runtime just makes
KeepAlive respawn it, and running `npm run start` / `nohup node dist/index.js`
starts a SECOND, unmanaged instance that fights the launchd one over the Telegram
poll lease + live-recovery-coordinator lease → Telegram goes silent, prompts
wedge, "another runtime is the live recovery coordinator" / "polling lease is held
by another runtime" spam. Two+ instances ran at once.

**How to apply — USE THE PRODUCT CLI, don't hand-roll.** The product already
ships service lifecycle: `@gantry/runtime` exposes bin `gantry` (dist/cli/index.js),
and `apps/core/src/cli/index.ts` + `apps/core/src/infrastructure/service/launchd.ts`
implement `start`/`stop`/`restart`/`status` — the launchd path does `bootstrap`
(if needed) then `kickstart -k` correctly. So to restart the local runtime after a
`npm run build:runtime`, run **`gantry restart`** (published bin) or locally
**`node dist/cli/index.js restart`**. Status: `gantry status`. There must be
EXACTLY ONE `node dist/index.js` (`pgrep -fl dist/index.js`). NEVER `npm run start`,
`node dist/index.js`, `nohup`, or `pkill` the runtime, and don't hand-roll launchctl
one-liners or helper scripts — the CLI is the supported path and works for npm
users too. A rebuild alone does nothing until you `gantry restart`.

**Latent bug to fix on next reload:** the plist pins a version-specific node path
(`/opt/homebrew/Cellar/node/25.2.1/bin/node`) — it breaks on a Homebrew node
upgrade. Change both occurrences (and the PATH entry) to the stable symlink
`/opt/homebrew/bin/node`, then apply with a full reload (`launchctl bootout
gui/$(id -u)/com.gantry` + `launchctl bootstrap gui/$(id -u) <plist>`); a plain
`kickstart` does NOT pick up plist edits.

Related: [[background-task-kills-environment]] (why detached bash restarts were
unreliable too).
