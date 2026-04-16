# Apps Core

## Scope

- `apps/core/src/` contains the runtime, routing, session, memory, and storage code for MyClaw.

## Rules

- Keep runtime imports aligned with the split domains under `apps/core/src/` rather than rebuilding root wrapper modules.
- Service changes must keep `ops/bootstrap.sh`, `ops/launchd/com.myclaw.plist`, and runtime diagnostics consistent.
- CLI onboarding code in `apps/core/src/cli/` must remain runtime-home based (`AGENT_ROOT`) and must not assume repo cwd.
- Keep prompt rendering separate from side-effect modules so onboarding behavior stays testable.
- `myclaw` CLI commands should return actionable plain-English recovery guidance instead of raw startup failures.
- When path-sensitive code changes, update the matching tests in `apps/core/src/**/*.test.ts` in the same change.
- Host runner sync code must work with npm workspace hoisting and installed package layouts; do not assume `packages/agent-runner/node_modules` exists.
- Files under `apps/core/src/bootstrap/` own composition and wiring only; runtime behavior must live in `runtime/`, `session/`, `platform/`, `messaging/`, or storage modules.
