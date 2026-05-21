# Channel Wiring Notes

- `sendStreamingChunk` is a transport handoff for incremental provider text.
  Preserve leading, trailing, and whitespace-only chunks; channel-specific
  stream sinks own buffering and final formatting.
- Required Adaptive Card sends must use durable outbound delivery with fallback
  text as canonical text and the card JSON as provider payload, so recovery can
  resend the same card rather than downgrading to plain text.
