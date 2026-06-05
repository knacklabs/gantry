# Sandbox Adapters

- Direct host command execution belongs in this adapter folder so architecture
  checks can keep risky `child_process` usage out of runtime and job handlers.
- Callers must pass already-reviewed, explicit argv plus scrubbed environment;
  this layer runs commands, but it does not decide permission policy.
- Runner sandbox providers are adapter-owned. Runtime code passes workspace,
  protected paths, resource limits, egress proxy, and principal metadata; this
  folder translates that policy into the concrete process wrapper.
- The `direct` runner provider is not an enforcing sandbox. Use it only as the
  local compatibility provider and keep fail-closed behavior in runtime callers.
