# Single-Host Hardening Plan — Securing Gantry on One Machine

**Status:** Phases 1-6 implemented in the host runner path; host operations remain deployment tasks · **Date:** 2026-06 · **Owner:** Runtime
**Scope:** Make Gantry secure running **vertically on a single machine** (Linux or macOS) for **personal** and **organisation** use, in a way that is **forward-compatible** with a later **horizontal / cloud** execution plane.
**Non-goal (for now):** Multi-host autoscaling, remote sandbox fleet. That is a later phase and is sketched only at the end so today's work doesn't block it.

---

## TL;DR

1. Gantry now has a `RunnerSandboxProvider` spawn seam at `apps/core/src/runtime/agent-spawn-process.ts`, with fail-closed behavior when the configured provider cannot start.
2. `runtime.sandbox.provider` selects either `direct` or the enforcing `sandbox_runtime` provider. `direct` preserves local compatibility and is not an OS sandbox.
3. The enforcing provider uses pinned `@anthropic-ai/sandbox-runtime@0.0.52` (Bubblewrap on Linux, Seatbelt on macOS), a per-run config file, broad read with protected-path read denies, workspace/runtime/temp writes with protected-path write denies, approved `networkHosts`, and Gantry's egress proxy. In this mode Gantry uses one whole-runner OS sandbox instead of nesting the Claude SDK sandbox inside it.
4. Resource caps are settings-owned under `runtime.sandbox.resource_limits` and are applied before the runner starts.
5. Stdio MCP projected into the model runner is contained by the same whole-runner sandbox when `runtime.sandbox.provider: sandbox_runtime` is configured. The separate admin/current-session MCP proxy remains fail-closed for stdio unless it is wired to an enforcing sandbox provider.
6. Live turns, scheduled job prompt runs, scheduler recovery turns, and native SDK subagents share this same runner boundary. Native subagents run inside the parent SDK process; host-owned system jobs remain trusted control-plane work.

---

## Sandbox Modes

`runtime.sandbox.provider` is the only v1 execution-mode authority.

- `direct`: personal/laptop compatibility mode. It is the easiest local setup and has no outer OS sandbox.
- `sandbox_runtime`: enforcing single-host mode. Use this for organisation and safe-host deployments after `gantry doctor` confirms host support.
- Docker/cloud sandbox: future optional backend. It is not required for v1 and does not create a separate organisation mode.

Browser stays host-managed through Gantry IPC. Stdio MCP servers, local CLIs, skills, jobs, and native subagents follow the configured sandbox provider. The sandbox does not install tools; missing CLI binaries, MCP servers, skill dependencies, or auth preflights are setup blockers, not permissions. In `sandbox_runtime`, networked tools must use standard proxy-aware clients (`HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`); tools that bypass those proxies fail closed.

Switch modes in `~/gantry/settings.yaml`:

```yaml
runtime:
  sandbox:
    provider: sandbox_runtime
```

Then verify the host and runtime:

```bash
gantry settings validate
gantry service restart
gantry doctor
gantry status
```

Expected status labels are `Sandbox: direct (compatibility, no OS sandbox)` and `Sandbox: sandbox_runtime (enforcing)`.

---

## 1. Threat models

### Personal (one trusted user, one machine)

The user is the admin. Primary risks come from the **agent itself** being prompt-injected or running a malicious skill/MCP:

- Reading secrets: `~/.ssh`, `~/.aws`, `~/.gnupg`, `*.env`, keychains.
- Destructive shell: `rm -rf`, overwriting host files outside the workspace.
- Exfiltration: posting stolen data to an arbitrary host, or hitting cloud metadata (`169.254.169.254`).

**Goal:** contain the agent's blast radius to a scoped workspace + an allowlisted network, on the host.

### Organisation (many humans, one shared host, one Gantry)

Everything above **plus** isolation _between_ tenants sharing the box:

- One user's run must not read another user's workspace, artifacts, or credentials.
- Memory must not leak across users/groups (already schema-enforced — verify under concurrency).
- Capability grants should be approved by an **org admin/approver**, not arbitrary end users.
- Audit must be retained and exportable.

**Goal:** per-tenant isolation on a single host, with admin-controlled approval and durable audit.

---

## 2. Where Gantry stands today (the seams)

Gantry has the **policy surface** but not the **enforcement engine**:

| Asset                           | Location                                                                                         | State                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Single process-spawn chokepoint | `apps/core/src/runtime/agent-spawn-process.ts` (`RunnerSandboxProvider.start`)                   | Provider-required, fail-closed, and wired from runtime settings                                            |
| Per-capability sandbox policy   | `apps/core/src/shared/semantic-capabilities.ts` (`sandboxProfile { network, filesystem }`)       | Declared; runner path maps the default runner profile to an enforcing provider when configured             |
| Stdio MCP requires a profile    | `apps/core/src/application/mcp/mcp-server-policy.ts:137` (`sandboxProfileId`)                    | Required field, no enforcer                                                                                |
| Stdio MCP execution             | `agent-spawn.ts` runner projection; `mcp-tool-proxy.ts` current-session proxy                    | Runner projection is contained by the runner sandbox; current-session proxy remains fail-closed            |
| Sandbox output detection        | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/sandbox-events.ts:36`                  | Already greps for `seatbelt\|landlock\|seccomp\|denyWrite`                                                 |
| Audit event types               | `apps/core/src/domain/events/runtime-event-types.ts:37-38` (`EGRESS_CONNECT`, `SANDBOX_BLOCKED`) | Defined, ready to emit                                                                                     |
| In-process egress proxy         | `apps/core/src/runtime/egress-gateway.ts` + `apps/core/src/shared/egress-policy.ts`              | Enforces configured proxy traffic; raw sockets remain possible until OS network isolation                  |
| Mount allowlist                 | `~/.config/gantry/mount-allowlist.json` (see `docs/SECURITY.md`)                                 | Policy exists                                                                                              |
| File artifact store             | `apps/core/src/domain/ports/file-artifact-store.ts` (+ postgres repo)                            | Enables disposable workspaces later                                                                        |
| Signed IPC                      | `GANTRY_IPC_AUTH_SECRET`, run/workspace/app-scoped HMAC                                          | Trust seam for runner ↔ host                                                                               |

**Reading:** the plumbing was clearly written in anticipation of an OS sandbox. We are filling the gap, not redesigning.

---

## 3. The off-the-shelf enforcer: `@anthropic-ai/sandbox-runtime`

Anthropic's open-source sandbox (repo `anthropic-experimental/sandbox-runtime`, npm `@anthropic-ai/sandbox-runtime`, vendored by Claude Code) does exactly what Phase 3/4 needs:

- **OS-level FS + network restriction on arbitrary processes, no container.**
- **Linux:** Bubblewrap (user namespaces). **macOS:** Seatbelt (`sandbox-exec`).
- **Filesystem:** allow broad reads except explicit protected paths, restrict writes to configured workspace/runtime paths, and enforce both for the process **and its children**.
- **Network:** removes the network namespace (Linux) / Seatbelt profile (macOS) and routes egress through a **proxy running outside the sandbox** that enforces a domain allowlist.

Because Gantry runs on Node and already spawns the runner as a child process, Phase 3 should evaluate wrapping that spawn with this library instead of writing bwrap/Seatbelt profile generators by hand. This is not active v1 behavior.

**Honest caveats (track these):**

- It has prior bypass history. Validate the exact fixed version from primary advisory/source data before pinning, watch advisories, and treat it as defense-in-depth, not a single point of trust.
- Upstream it primarily sandboxes the **Bash tool**, not every tool. Gantry's Phase 3 proposal would evaluate sandboxing the **entire runner process** so all tools and harness subprocesses are contained. That is not active v1 behavior.
- It is a **research/early preview**. Combine it with Phase 0 host lockdown and the egress proxy; do not rely on it alone.

---

## 4. The architecture move

Use the **`RunnerSandboxProvider` port** and route the spawn in `agent-spawn-process.ts` through it.

```
agent-spawn-process          ──►  RunnerSandboxProvider.start(spec)
                                     ├─ direct provider             (compatibility; not enforcing)
                                     ├─ SandboxRuntimeRunnerSandboxProvider (@anthropic-ai/sandbox-runtime: bwrap / Seatbelt)
                                     └─ RemoteSandboxProvider       (LATER: cloud microVM / deepagents remote backend)
```

- Provider input includes command, args, scoped env, workspace root, sandbox profile, protected paths, egress proxy, resource limits, and runtime principal metadata.
- The hardened provider maps `sandboxProfile { network, filesystem }` → the sandbox-runtime's FS/network config.
- If a configured hardened provider cannot satisfy the profile, it must **fail closed**.
- Keep the interface **host-agnostic** so `RemoteSandboxProvider` drops in unchanged later.
- The provider is command-generic: callers pass an explicit executable, cwd, runtime write paths, and protected paths. The read policy stays broad except explicit protected read denies so macOS/Linux tooling can resolve interpreters, linked libraries, and package stores without bespoke allowlists.
- Do not nest the Claude SDK filesystem sandbox inside `sandbox_runtime`; macOS Seatbelt rejects nested sandboxing in practice. The outer runner sandbox is the OS boundary for SDK-managed Bash/file/MCP subprocesses in enforcing mode, while `direct` mode keeps the Claude SDK sandbox. In outer-sandbox mode, mark the Claude Code child as already sandboxed, prefer the resolved `claude` executable on `PATH` when present, allow generated Claude session/cache state under the per-agent config directory, per-run temp directory, and Claude Code's uid-scoped temp directory, and keep stable settings, MCP, and skill definitions deny-write protected.
- On macOS, enable sandbox-runtime's weaker network isolation only for the enforcing outer sandbox so Go-based approved CLIs can verify TLS through `com.apple.trustd.agent`; Gantry's egress proxy and domain audit still enforce outbound policy.

This keeps the host runner provider-neutral. `direct` is explicit compatibility mode; `sandbox_runtime` is the single-host OS enforcement mode.

---

## 5. Phased plan (with verification gates)

> Effort labels: **[Today]** realistically doable now · **[Week]** the core security work over the next few days. Each step lists how to prove it works.

### Phase 0 — Host lockdown **[Today, mostly no code]**

Biggest blast-radius cut for least effort. Harness-agnostic.

- [ ] Run Gantry as a **dedicated non-login service user** (`gantry`), not a personal account.
  - _Verify:_ `ps -o user= -p <pid>` → `gantry`; the agent cannot read your personal `~/.ssh`.
- [ ] Harden the **mount allowlist** (`~/.config/gantry/mount-allowlist.json`): explicit deny on `~/.ssh`, `~/.aws`, `~/.gnupg`, `*.env`, keychains.
  - _Verify:_ a `FileRead` of `~/.ssh/id_rsa` is denied.
- [ ] **Postgres least-privilege**: dedicated role, local socket / `127.0.0.1` only, no `SUPERUSER`, not network-exposed.
  - _Verify:_ remote `psql` refused; role cannot escalate.
- [ ] Secrets file `chmod 600`, owned by service user. Confirm egress denylist blocks **cloud metadata** (`169.254.169.254`) and localhost ranges.
  - _Verify:_ `egress.connect` to metadata IP is blocked and logged.

### Phase 1 — `RunnerSandboxProvider` seam **[Today]**

- [x] Define `RunnerSandboxProvider` in `apps/core/src/shared/runner-sandbox-provider.ts`.
- [x] Route the spawn in `agent-spawn-process.ts` through it.
- [x] Ship a default direct-spawn provider so current behavior does not regress.
- [x] Fail closed if a configured provider cannot spawn the runner.
  - _Verify:_ focused unit tests cover provider input and fail-closed behavior; full suite should remain green before merge.

### Phase 2 — Privilege drop + resource caps **[Today, Tier 1]**

- [x] Spawn the runner with hard limits configured under `runtime.sandbox.resource_limits`. Current implementation applies portable `ulimit` caps; cgroup v2 remains an optional future strengthening if a deployment needs it.
  - _Verify:_ a forkbomb or memory-hog in a tool call is capped to the run; the host stays responsive.

### Phase 3 — OS sandbox via `@anthropic-ai/sandbox-runtime` **[Week, the core fix]**

- [x] Add `SandboxRuntimeRunnerSandboxProvider` implementing the port with pinned `@anthropic-ai/sandbox-runtime@0.0.52`.
- [x] Map `sandboxProfile { network, filesystem }` → sandbox FS/network config; allow broad reads except protected paths, restrict writes to the run's workspace/runtime paths, and deny protected credential/config writes.
- [x] Emit `SANDBOX_BLOCKED` when provider startup fails or stderr matches sandbox denial signatures; SDK-side sandbox detection remains in `sandbox-events.ts`.
- [x] Report sandbox provider/enforcing state in `gantry status`, `gantry doctor`, job-start events, and sandbox-blocked events.
  - _Verify (both Linux and macOS):_ an agent tool reading `~/.ssh/id_rsa` is **blocked + emits `SANDBOX_BLOCKED`**; a write outside the workspace fails.

### Phase 4 — Hard network boundary **[Week]**

- [x] Use sandbox-runtime network isolation plus Gantry's out-of-sandbox **egress proxy**. The enforcing provider projects approved capability `networkHosts` into the sandbox-runtime allowlist, then keeps enforcing the existing `permissions.egress.denylist` and egress audit at the proxy.
  - _Verify:_ a raw `connect()` from inside a tool fails; denylisted, proxied egress is blocked; allowed proxied egress succeeds; every hop logs `egress.connect`.

### Phase 5 — Unlock stdio MCP behind the sandbox **[Week, capability payoff]**

- [x] Project reviewed stdio MCP servers into the model runner path, where they are contained by the same enforcing runner sandbox when `runtime.sandbox.provider: sandbox_runtime` is configured.
- [x] Keep the separate current-session/admin `mcp-tool-proxy.ts` stdio execution fail-closed until that adapter receives the same enforcing sandbox context.
  - _Verify:_ a stdio MCP server projected into a runner cannot escape the workspace or reach denied hosts.

### Phase 6 — Org tenant isolation on one host **[Week]**

- [x] **Per-agent workspace dirs**, `0700`, with the Phase-3 profile pinning the bind-mount to _that run's_ workspace — run A cannot mount run B's files through the runner sandbox.
- [x] Keep **memory isolation** delegated to existing app/agent/subject boundaries and artifact-store scoping; no new cross-tenant storage path is introduced.
- [x] Keep **approver separation** in the existing conversation approver model.
- [x] Keep **audit retention** through existing `runtime_events`, including `egress.connect` and `sandbox.blocked`.
  - _Verify:_ two concurrent runs from different users — neither can read the other's workspace, memory, or credentials.

---

## 6. Harness note — Claude Agent SDK today, deepagents tomorrow

The Phase-1 seam does **not** change when the harness is swapped, because the host runner launch path stays the same. Current v1 does not run model loops inside a sandbox; risky file/shell execution still depends on Gantry permission gates and the later sandbox backend.

- **Claude Agent SDK (today):** the SDK/Claude Code sandbox primitives are the _same_ `@anthropic-ai/sandbox-runtime` underneath — so Phase 3 aligns naturally.
- **deepagents (tomorrow):** LangChain's harness routes all fs/shell through a `BackendProtocol`, and when a _sandbox backend_ is detected it hands the agent a **raw `execute` shell tool**. That is the opposite of Gantry's "no raw Bash, only `RunCommand(<template>)`" stance.

**Decision — adopt Model A plus Gantry gate when Phase 3 lands: Gantry's OS sandbox wraps the runner process, and org-mode `execute` routes through Gantry's permission gate.**

- Run deepagents in plain **local backend** mode; let Gantry's Phase-3/4 sandbox + egress proxy + per-tenant workspace contain the entire harness, including its `execute` shell and any MCP subprocesses it spawns.
- Gantry's permission gate, audit, and supply-chain review stay authoritative.
- **Because deepagents ships an unsandboxed shell by default, Phase 3 is a HARD PREREQUISITE before enabling the deepagents `execute` tool.**
- Do **not** double-jail: if you ever use deepagents' own bubblewrap backend, don't nest it inside Gantry's bwrap. Pick one layer (Gantry's, for single-host).

**Locked sub-decision (deepagents `execute` vs. Gantry gate):**

- Personal/experimental mode may start jail-only after Phase 3 is verified.
- Org mode must route `execute` back through Gantry's permission gate before exposing it.
- This preserves the semantic-capability model and per-action audit where tenant risk exists.

**Status (implemented):** the `deepagents:langchain` adapter never uses a
deepagents execution backend. The runner uses the default `StateBackend` (no
`execute`), deny-all filesystem permissions, and never `LocalShellBackend` /
`FilesystemBackend`; the baked-in `task`/`write_todos`/filesystem tools stay
excluded from the model surface. Shell execution is available ONLY through a
Gantry-owned, policy-gated, sandbox-confined tool injected into `tools`:

- `deepAgentsEnforcingSandboxGuard` (the single operative pre-spawn guard in
  `apps/core/src/runtime/deepagents-shell-filesystem-guard.ts`) fails the spawn
  closed when a DeepAgents run requests shell (`Bash`/`RunCommand`) or filesystem
  (`FileRead`/`FileWrite`/`FileEdit`/`FileSearch`) authority that cannot be
  confined — `direct` mode, or any production/remote posture without an enforcing
  `sandbox_runtime` provider — with `DeepAgents requires an enforcing sandbox
  before shell or filesystem tools can be enabled in this deployment mode.` Under
  `sandbox_runtime` the guard returns null (allowed).
- On the allowed path the host projects `GANTRY_DEEPAGENTS_SHELL_ENABLED='1'`
  (derived from the SAME guard inputs via `deepAgentsShellEnabledEnv`). The runner
  then injects a `RunCommand`-named LangChain tool (`gantry-shell-tool.ts`) ONLY
  when that flag is set AND a resolved `RunCommand(...)` rule is present. The tool
  shapes its `{ command }` input into a `Bash` policy request and runs the same
  neutral gate the third-party MCP tools use (protected-capability/memory/yolo
  pre-checks → `evaluateNeutralToolPolicy` → durable `requestPermissionApprovalViaIpc`).
  Denied calls return the deny string to the model and never execute; allowed
  calls `spawn` a child of the already-sandboxed runner, inheriting the OS
  confinement (protected-path write denies) and the runner's egress-proxy env.
  Filesystem (`File*`) tools are NOT projected in this phase (shell only).

---

## 7. Forward-compatibility with cloud / horizontal (LATER)

Nothing today blocks the horizontal move; it is the **same port, a new adapter**.

- Split **control plane** (orchestrator, GroupQueue, Postgres, pg-boss, permission gate, host-owned MCP tools, egress policy, credential broker — trusted, central, scales behind a LB) from **execution plane** (ephemeral, isolated sandboxes that run one turn then die — untrusted).
- `RemoteSandboxProvider` implements the Phase-1 port against **Firecracker / gVisor / Kata** microVMs, or directly against **deepagents' remote backends (Runloop / Daytona / Modal)** — which are essentially a ready-made remote execution plane.
- Why Gantry is well-positioned: tool calls already route through a host-owned gate over signed IPC (promote stdio → mTLS), agents are stateless per turn, durable state is in Postgres + the file-artifact store, and GroupQueue already caps concurrent containers (becomes the dispatcher).
- The cloud path is also how Gantry reaches **full MXC-parity isolation** (microVM tier) — the macOS-dev limitation disappears when we control the Linux+KVM host.

---

## 8. Decisions to confirm before coding

1. **Linux FS/syscall layer:** use **`@anthropic-ai/sandbox-runtime`** first; hand-rolled Landlock/seccomp is deferred unless the dependency cannot satisfy Gantry's profiles.
2. **Isolation granularity:** start with one **dedicated service user** for personal + small org; defer per-run ephemeral uid until org verification proves it is needed.
3. **deepagents `execute` gating:** personal/experimental can be jail-only after Phase 3; org mode must route through Gantry's permission gate.
4. **Sandbox-runtime version pinning:** confirm a fixed, advisory-clean version and a process for tracking bypass advisories before adding the dependency.

---

## 9. Honest limitations

- `@anthropic-ai/sandbox-runtime` is an early preview with a prior bypass history; it is **defense-in-depth**, not a sole trust boundary. Phase 0 + egress proxy + supply-chain review remain essential.
- On **macOS** the ceiling is Seatbelt (best-effort), not a kernel VM boundary. True microVM parity (MXC-class) only arrives with the **Linux + KVM** cloud tier in §7.
- Single-host org mode shares one kernel across tenants; OS sandbox + per-tenant workspace mitigate but do not match per-tenant microVM isolation. That is the explicit reason the horizontal phase exists.

---

## 10. Source references

- Anthropic — [Making Claude Code more secure and autonomous with sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- Anthropic — [`anthropic-experimental/sandbox-runtime` (GitHub)](https://github.com/anthropic-experimental/sandbox-runtime) · npm `@anthropic-ai/sandbox-runtime`
- Claude Code Docs — [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing)
- Claude API Docs — [Securely deploying AI agents](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
- LangChain — [Sandboxes for Deep Agents](https://changelog.langchain.com/announcements/sandboxes-for-deep-agents) · [DeepAgents sandboxes docs](https://docs.langchain.com/oss/python/deepagents/sandboxes) · [harness docs](https://docs.langchain.com/oss/python/deepagents/harness)
- Gantry source: `agent-spawn-process.ts`, `semantic-capabilities.ts`, `mcp-server-policy.ts`, `mcp-tool-proxy.ts`, `sandbox-events.ts`, `runtime-event-types.ts`, `egress-gateway.ts`, `egress-policy.ts`, `file-artifact-store.ts`, `docs/SECURITY.md`.
