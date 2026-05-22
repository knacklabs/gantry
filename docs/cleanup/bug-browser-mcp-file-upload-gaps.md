# Fixed: Browser MCP file attach for upload inputs

## Summary

Gantry previously could not attach a local file to an `<input type=file>` on
hardened third-party sites through the documented browser MCP surface. The
browser gateway now ships `browser_act` action `file_attach`, backed by
Playwright `setInputFiles`, Gantry-owned staging, and path allowlisting.

Status: fixed in code and documented in
`docs/architecture/browser-capability.md`. Manual verification against
chatgpt.com remains useful before deleting this cleanup note because the
original failure was observed there.

## Historical Reproduction

1. Open `https://chatgpt.com/` with `browser_open`.
2. Click the composer's `Add files and more` menu and select
   `Add photos & files`.
3. Call the retired upload shape:

```text
browser_act {
  action: "file_upload",
  target: "<hidden input handle>",
  paths: ["/tmp/claude/some.zip"],
  profile: "full",
  reason: "..."
}
```

Historical result: `Browser upload/drop filesystem paths are not accepted.`

## What Changed

Agents now use one documented action:

```text
browser_act {
  action: "file_attach",
  target: "<element handle>",
  source: {
    type: "artifact" | "bytes" | "path"
  },
  profile: "full",
  reason: "<why>"
}
```

Implemented behavior:

- `artifact` resolves a Gantry-managed FileArtifact through signed app/agent
  scope, then stages it under the browser artifact root.
- `bytes` stages small UTF-8 or base64 content under the browser artifact root.
- `path` accepts regular files only under the run browser artifact root or host
  temp directory.
- Hidden browser state, settings, credentials, browser IPC directories,
  symlinks, and paths outside the allowlisted roots fail closed before
  Playwright sees a path.
- Browser activity audit records the public `browser_act` call and backend
  `file_attach` action. Durable authority remains the single canonical
  `Browser` capability.

## Original Workarounds

These workarounds are no longer required for normal upload tasks:

| Approach | Historical result |
| --- | --- |
| `browser_act file_upload` with original path under `~/Workdir/...` | Rejected: backend policy banned path uploads. |
| Same call with the file copied to sandbox-writable `$TMPDIR` | Same rejection. Path location was not the gate; the action itself was denied. |
| `browser_act evaluate` fetching loopback content into a `DataTransfer` | Hardened site CSP blocked loopback fetches. |
| Inline base64 chunking through repeated `evaluate` calls | Impractical for multi-MB uploads and tool-call payload size. |
| AppleScript to drive the visible Chrome window | Sandbox blocked `System Events`. |
| Direct CDP attach plus Playwright `input.set_input_files(path)` | Worked, but bypassed the controlled browser MCP surface. |

## Verification Status

- Shipped: `browser_act file_attach` is the supported upload action.
- Shipped: path-source uploads outside the allowlist are rejected before
  Playwright receives a path.
- Shipped: `docs/architecture/browser-capability.md` documents `file_attach`,
  source types, path policy, and audit behavior.
- Residual manual check: verify a real chatgpt.com upload once before deleting
  this cleanup note.

## Notes

- Original repro session: 2026-05-18, while uploading
  `gantry-codebase-for-gpt.zip` (4.6 MB) into a GPT-5.5 Pro Extended chat.
- The direct CDP workaround used `chromium.connect_over_cdp` and
  `set_input_files` against the first unrestricted `input[type=file]`. It is a
  debugging escape hatch now, not a required product path.
