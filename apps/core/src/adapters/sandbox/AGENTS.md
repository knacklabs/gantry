# Sandbox Adapters

- Direct host command execution belongs in this adapter folder so architecture
  checks can keep risky `child_process` usage out of runtime and job handlers.
- Callers must pass already-reviewed, explicit argv plus scrubbed environment;
  this layer runs commands, but it does not decide permission policy.
