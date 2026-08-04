# Channel Wiring Notes

- `sendStreamingChunk` is a transport handoff for incremental provider text.
  Preserve leading, trailing, and whitespace-only chunks; channel-specific
  stream sinks own buffering and final formatting.
