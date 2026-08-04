# MEDIA-1 Phase 1 — single-process Chrome for Remotion renders (darwin-arm64)

Status: implemented (skill-side). Phase 2 (400 MB pre-provisioning,
semantic-capability + skill selection, platform matrix) remains out of scope.

## Goal

Make Remotion renders launch single-process Chrome by default on this
workstation, so the live agent's render produces an MP4 without any manual
per-render flag.

## Render → Chrome launch path (as found)

Gantry source has **zero** Remotion/Chrome-render code. The render is entirely
agent-side:

- The agent renders with `npx remotion render` (Remotion `4.0.290`, `@remotion/cli`)
  inside its workspace, under the **direct** sandbox provider.
- Remotion resolves `chrome-headless-shell` itself and launches it via the
  `@remotion/renderer` package's open-browser launcher. `--no-sandbox` is
  **already** always in the arg list; `--single-process` is added **only** when
  `chromiumOptions.enableMultiProcessOnLinux === false` (applies to macOS +
  Linux despite the name — that launcher gates on
  `process.platform === 'linux' || 'darwin'`).
- The BROWSER-capability plumbing in `apps/core/src/runtime/browser-config.ts`
  / `browser-capability.ts` builds `--user-data-dir` for the *browser tool* and
  is **not** on the render path — renders launch their own Chrome via Remotion.

Direct-mode sandbox network is already correct (`filesystem-sandbox.ts`:
`allowLocalBinding`, `allowUnixSockets`, `allowMachLookup` incl. `configd`), so
no sandbox change is needed. The only missing piece was single-process Chrome.

## Wiring point chosen (smallest that works)

Native Remotion option, not a wrapper script. Set in the render project's
`remotion.config.ts`:

```ts
import {Config} from '@remotion/cli/config';
Config.setChromiumMultiProcessOnLinux(false);
```

Config (not the `--enable-multiprocess-on-linux` CLI flag) because the flag is
**not** in Remotion's `BooleanFlags` list — minimist parses `=false` as the
string `"false"`, which is truthy, so the flag silently keeps multi-process on.
`Config.setChromiumMultiProcessOnLinux(false)` passes a real boolean and
reliably yields `--single-process`.

Plus workspace-local `HOME`/`TMPDIR` (real `$HOME` and system temp are
read-only in the sandbox; Chrome writes its profile under `TMPDIR` and crashpad
state under `HOME`):

```
mkdir -p .chromehome .tmp
HOME="$PWD/.chromehome" TMPDIR="$PWD/.tmp" npx remotion render
```

This matches the 2026-07-20 empirical proof (Chrome-for-Testing
`147.0.7727.57`, 210/210 frames → MP4), minus the wrapper script — the native
config option makes the wrapper unnecessary.

## Files changed

All skill-side (no Gantry source change — nothing on the render path lives in
this repo). The `remotion-render` skill definition now leads with the macOS setup
(`remotion.config.ts` + `HOME`/`TMPDIR`) and bakes the env into the canonical
render/still commands:

- `~/gantry/artifacts/skills/remotion-render/SKILL.md` (authoritative source)
- `~/gantry/artifacts/skills/remotion-best-practices/remotion-render/SKILL.md`
- `~/gantry/agents/main_agent/.llm-runtime/claude/skills/remotion-render/SKILL.md` (live copy)
- `~/gantry/agents/main_agent/.llm-runtime/claude/skills/remotion-best-practices/remotion-render/SKILL.md` (live copy)

## Chrome binary

Present — no download needed. `chrome-headless-shell` for Chrome-for-Testing
`147.0.7727.57` (mac_arm) is already cached under the Chrome-for-Testing cache
directory (revision `mac_arm-147.0.7727.57`) and Remotion resolves it via its own
revision lookup.

## Exact command a render now runs

In the render project (with the `remotion.config.ts` above present):

```
mkdir -p .chromehome .tmp
HOME="$PWD/.chromehome" TMPDIR="$PWD/.tmp" npx remotion render
```

Remotion then launches `chrome-headless-shell` with `--single-process
--no-sandbox` (among its standard flags), avoiding the Mach rendezvous 1100
denial and producing the MP4.
