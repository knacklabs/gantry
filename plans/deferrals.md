# Deferral Ledger

Deliberately-removed scope with explicit revisit triggers (`forge defer add`).
When a trigger fires, the item goes back on the roadmap and its row is
resolved: `./forge defer resolve <id> --notes "<what happened>"`.

| id | added | item | why deferred | trigger to revisit | status |
|----|-------|------|--------------|--------------------|--------|
| D-0001 | 2026-07-22 | Data retention for jobs/interactions/runtime events (split out of arch-quick-wins as cycle-sized) | Entangled with scheduler/lease/agent machinery; the promised ledger note never landed anywhere trackable | durable-work-primitive lane starts (it refactors the same jobs/interactions state) | open |
| D-0002 | 2026-07-22 | E2E persona/topology harness goal-prompt (re-draft) | goals-index referenced a scratchpad draft that did not survive; scope needs re-drafting from scratch | agent-e2e test-matrix reconciliation pass | open |
| D-0003 | 2026-07-22 | Split apps/core/src/application/mcp/mcp-tool-proxy.ts (ratcheted at 800 in architecture-map.json lineBudgets) | File is the capability-authoring lane's conflict window; splitting on main would collide with branch feature/capability-authoring @13ae2e698 | CAP-1 capability-authoring closeout merges | open |
| D-0004 | 2026-07-22 | Retire the provider_specific_path exception on apps/core/src/shared/sdk-native-skill-names.ts (4 anthropic matches, sentinel contract) | anthropic_sdk is a deliberate sentinel token per decision 0028; relocation breaks layer rules, so an exact-count exception is the sanctioned cap | any change to the agent-harness selection vocabulary superseding decision 0028 | open |
| D-0005 | 2026-07-23 | L2ii escape hatch (allowUnsandboxedCommands) for the video-render Mach-registration unblock | allowUnsandboxedCommands runs commands OUTSIDE the SDK sandbox, so the retained credential/protected denylist cannot guard escaped commands; the deterministic rails lack authoritative GANTRY_PROTECTED_FILESYSTEM_* + local_cli paths and can be preempted by reviewed-rule allow. Enabling the escape hatch now would open a credential-read bypass (S-0005-5cf6). | rails gain authoritative protected-path coverage (thread GANTRY_PROTECTED_FILESYSTEM_* + local_cli credentialDirs into the secrets/protected rail) AND rails run before any reviewed-rule allow for escape-eligible commands | open |

<!-- D-0005 design note (client correction 2026-07-23): the end-state is NOT
"sandbox on as defense-in-depth with a per-command escape hatch" — that still
leaves the OS Seatbelt blocking legitimate non-credential work (proven: Chrome
Mach registration; likely others). The target is Claude-Code's model: NO OS
sandbox; authorization is the SOLE control. Control happens BEFORE execution
(empowered+cached classifier + rails), not during it (OS jail). Once approved a
command runs with FULL OS access. The empowered classifier auto-allows the safe
majority so the user is never prompted for small commands (ls, git status, a
render, the Nth npm run) — only a genuinely risky un-cached effect asks once and
is remembered. The ONLY thing that survives sandbox removal is the credential/
protected-path guard, moved INTO the rails as a pre-execution deny-floor using
PERM-2's exact-target (symlink/cwd-resolved) resolution. So: sandbox fully off;
rails carry authoritative GANTRY_PROTECTED_FILESYSTEM_* + local_cli paths and
precede every allow for escape-eligible commands; empowered classifier for the
rest. Depends on PERM-2 effect-key work. -->
