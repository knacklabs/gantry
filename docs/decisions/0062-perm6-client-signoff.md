---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-26
---

# Perm6 Client Signoff

## Context
The lead-maintenance job kept stalling on "Needs permission". Ravi reported it live on
2026-07-26 and asked for the issue to be fixed; his agent independently diagnosed it.

What actually happens: the host wraps every job shell command with network-proxy environment
assignments (`GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:<port>/' ...`) so the command's
traffic goes through the egress proxy. The permission check then judges the WRAPPED text.
Confirmed in the runtime log — the refused `commandPreview` begins with the proxy wrap, and the
refusal is "Shell input is unsupported: Bash environment assignments are not supported",
cancelled by `deterministic_rails`.

Two knock-on effects make it unfixable from the outside:
- the proxy port rotates every run, so the wrapped text differs each time and no saved command
  rule can ever match;
- even a human grant cannot help, because the rails hard-refuse env assignments before any rule
  or classifier runs.

PERM-3 built the exact remedy: `applyBashTrustEnvWithProvenance` wraps the command AND returns
`hostInjectedCommandPrefix`, and `stripShellCommandEnvPrefix` removes that declared prefix
before the check judges the command. It is wired in the interactive lane
(`tool-permission-gate.ts:231`). The job lane injects the same wrap but never declares it.

The immediate incident is resolved at the job level — the job now uses its injected IST time
and the reviewed Sheets capabilities instead of shelling out. This task fixes the lane, so any
other job that runs any shell command does not hit the same wall.

## Decision
Ravi asked on 2026-07-26 to fix the issue ("Try fixing the issues — is it with running,
permissions or just the job itself"). Scope: thread the host-injected prefix declaration
through the job-run shell path, exactly as the interactive lane already does, so the permission
check and rule matching judge the clean command.

## Consequences
- Job shell commands become classifiable and grantable again: a read-only `date +%A` can
  auto-allow, and a saved rule for a command can match regardless of the rotating proxy port.
- The hard floor on environment assignments is NOT relaxed. A command that genuinely contains
  user-authored env assignments (for example `TZ=Asia/Kolkata date`) is still refused — only
  the HOST's own declared wrap is stripped, provenance-exact, as PERM-3 designed.
- The fix must not weaken the trust boundary: the prefix is stripped only when it matches the
  declared host-injected prefix byte-for-byte. Anything else is judged as-is.
