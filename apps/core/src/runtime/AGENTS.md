# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.
- The Claude CLI remote-control path was removed. Do not reintroduce direct
  provider-specific remote-control spawning in runtime; any future equivalent
  must be a provider-neutral application capability with explicit permission
  and adapter ownership.
- Prepared execution adapters may pass only narrowly allowlisted runner context
  through `agent-spawn`: provider config/model hints plus host-derived skill
  action metadata. IPC auth tokens, MCP paths, provider credentials, arbitrary
  caller env, and other authority-bearing env must stay host-owned or in the
  model credential runner-input lane.
