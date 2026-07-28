# Channel Wiring Notes

- `sendStreamingChunk` is a transport handoff for incremental provider text.
  Preserve leading, trailing, and whitespace-only chunks; channel-specific
  stream sinks own buffering and final formatting.
- Startup must activate model aliases from the authoritative runtime settings
  after either file or revision loading; parsing a revision document alone does
  not update the process model catalog.
- Re-activate those authoritative aliases after local preflight and watcher
  initialization, before runtime services start, because loading a different
  local mirror also updates the process-wide catalog.
