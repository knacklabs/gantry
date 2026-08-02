---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-23
---

# Permission & Execution: Two-Axis, Provider-Authoritative Model

## Context
The direct-mode SDK Seatbelt blocked legitimate work (Chromium's Mach-port
registration — the whole mach-register class) with no surgical escape: the SDK
exposes `allowMachLookup` but no mach-register lever, and `ignoreViolations` only
suppresses reporting. Research into Claude Code (`codeaashu/claude-code`) and Codex
(`openai/codex`) source confirmed the industry pattern: **authorization and OS
confinement are two orthogonal axes**, not one knob. Claude Code ships with the
sandbox OFF by default ("permission prompts are the security control"); Codex keeps
`approval_policy` and `sandbox_mode` as independent enums where "never-ask" != 
"no-sandbox" and "full-access" != "never-ask".

## Decision
Adopt a two-axis, **provider-authoritative** model. The user chooses the execution
mode; Gantry adheres — no production override, no per-command media-gating.

1. **Axis A — Authorization** (always on, both lanes, both modes): the host-side
   coordinator + deterministic rails (strongest-wins precedence: hard-deny ->
   locked -> fixed-image -> reviewed-rule -> rails -> classifier -> human) + the
   schema-enforced, fail-closed-to-ask classifier + decision memory (scoped:
   once / this-folder / standing). This is the single control in `direct`.
2. **Axis B — Confinement** (`sandbox.provider`): `direct` = no inner OS sandbox
   (authorization + the deployment boundary are the isolation); `sandbox_runtime`
   = the OS jail. Gantry does not force `sandbox_runtime` in production and does
   not fail DeepAgents shell closed under `direct`.
3. **Escape-as-new-action** (Codex's strongest pattern, tracked as SANDBOX-1):
   under `sandbox_runtime`, an OS-jail denial does NOT fail dead — it raises a
   separate, scoped approval to retry with the specific added capability. A
   sandboxed approval NEVER implicitly authorizes an unsandboxed retry; managed
   denied-read constraints (`~/.ssh`, `~/.aws`) stay non-escapable.

## Implementation Note — 2026-07-28

The shipped worker order adds an exact classifier-cache stage after
deterministic rails and before classifier consultation. The cache is scoped by
the parent conversation when present, shared by its threads, and reuses only a
classifier `allow`; human `Allow once` is never reusable. Learned trusted roots
and `Allow for future` rules are agent-owned durable authority, not
conversation-local grants. Inline/core lanes share the host coordinator's hard
precedence but do not all provide the optional cache/classifier stages.

`direct` remains selectable in workstation, production, and fleet deployments,
but it provides no inner SDK or Gantry OS confinement. Its deployment
host/container/VM is the OS boundary. `sandbox_runtime` remains optional
defense-in-depth for deployments that require whole-runner confinement.
`direct` alone does not establish isolation between mutually untrusted tenants
sharing one container; that topology must select and prove an appropriate
tenant-isolation boundary.

## Consequences
- `direct` mode drops the Anthropic SDK Seatbelt entirely (Chromium + the
  mach-register class run); the host-side credential/protected-path rail is the
  credential guard (moved off the Seatbelt, not removed). Egress stays routed via
  the HTTP(S)_PROXY -> run-scoped gateway (advisory in `direct`, hard-enforced only
  under `sandbox_runtime`). Now-dead SDK-filesystem-sandbox code is deleted.
- DeepAgents shell runs under `direct` (gated by its RunCommand rule + coordinator,
  not a sandbox-provider fail-closed). `sandbox_runtime` still confines it.
- `security-posture` no longer forces an enforcing sandbox; the provider is the
  user's choice.
- Deliberately NOT copied from the references: Claude Code's Accept-Edits shell
  alias (auto-allowing `rm`/`mv`/`sed` as "edit-like"); prompt-only Plan mode.
- Follow-ups: SANDBOX-1 (escape-as-new-action for `sandbox_runtime`); optionally
  enrich the classifier verdict to Codex's `risk` + `authorization_strength` shape.
