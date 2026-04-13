# Agent Runner

## Scope

- `packages/agent-runner/src/` is the isolated runner package used by the host runtime and MCP bridge.

## Rules

- Keep this package buildable through the repo workspace install flow; root `npm ci` must be enough to build it.
- Host/runtime contract files that are mirrored into `apps/core/src/` must stay in sync with their test coverage intact.
- Changes here should preserve stable CLI entrypoints under `dist/index.js` and `dist/ipc-mcp-stdio.js`.
- If this package gains new runtime dependencies, make sure the root package publish/install flow still provides them to host runtime sync.
