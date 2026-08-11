# Design: structured invocation for local-CLI capabilities

## Problem (root, not symptom)

A `local_cli` semantic capability (e.g. `google.sheets.values.get`, wrapping the
`gog` CLI) pins the executable — `executablePath`, `executableHash`,
`commandTemplates` — but its ONLY invocation path is a projection to a
`RunCommand(<template>)` autonomous rule (`semantic-capabilities.ts:202-206`).
The agent therefore invokes the capability by hand-authoring a shell string and
running it via Bash/RunCommand. Everything that has bitten us follows from that
one choice:

- the agent can (and does) append benign post-processing — `gog sheets get … |
  head` — to bound output that the runtime already bounds;
- the extra pipe leaf misses the scoped rule (per-leaf matching, correctly — a
  granted command must not drag a second command in behind a pipe);
- the miss drops to the non-deterministic LLM risk classifier;
- on an autonomous (scheduled) run a classifier "ask" is a terminal,
  non-grantable denial (decision 0115), so the job fails with no button.

Observed live: the KnackLabs job failed on `gog sheets get … 2>&1 | head -`
after identical non-piped `gog` commands were allowed by the reviewed rule in
the same run. It is luck-of-the-draw whether a run survives.

An allowlist of "safe pipe targets" only moves the boundary and is whack-a-mole
across CLIs (grep, jq, awk, …). The durable fix is to stop the agent authoring
shell for these capabilities at all.

## Proposed fix (simplest durable form)

Give `local_cli` capabilities a **structured invocation tool** so no shell
string is ever composed.

- A single host tool, `capability_run`, takes `{ capabilityId, args: string[] }`
  (arguments as a list, never a shell string).
- The host resolves the granted capability, then runs the pinned executable
  directly with `execFile(executablePath, args)` — **no shell**, so pipes,
  redirects, `&&`, globs, and command substitution are structurally impossible.
- Output is bounded by the existing runtime truncation, so the agent never needs
  `| head`.
- Authorization is the existing binding check: "is this capability granted to
  this agent?" — deterministic, no per-leaf shell matching, no classifier in the
  loop. This is exactly why structured MCP tools (`todo_update`, `memory_save`)
  never had this problem; CLI capabilities are the last agent-authored-shell
  surface.
- Credentials, `protectedPaths`, `networkHosts`, `sandboxProfile`, and
  `executableHash` verification are applied by the host at invocation, as today.

## Scope (v1, deliberately small)

- Ship `capability_run` and wire the existing `local_cli` capabilities to it
  (gog/sheets is the pilot).
- Agent guidance: prefer `capability_run` for granted CLI capabilities; do not
  shell them out.
- Keep the RunCommand projection working during migration; decide separately
  whether to retire it for `local_cli` once structured invocation is proven.

## Non-goals

- No change to MCP capabilities, skill actions, or general Bash/RunCommand for
  non-capability commands.
- No new sandbox model; reuse the capability's existing execution controls.
- Not retiring the RunCommand projection in v1 (a follow-up decision).

## Open questions (for the critique)

1. Arg validation: how strictly should the host validate `args` against the
   capability's `commandTemplates` (subcommand allowlist? positional shape?), and
   is that meaningfully safer than trusting the pinned executable + args list?
2. Discovery/UX: how does the agent learn a capability is callable via
   `capability_run` (tool listing? guidance?) and pass structured args reliably?
3. Migration: existing jobs/agents invoke via RunCommand; do we auto-rewrite,
   dual-run, or just add the new path and let usage shift?
4. Should RunCommand for `local_cli` capabilities be actively DISABLED once
   `capability_run` exists, to remove the shell surface entirely — and what
   breaks if a capability genuinely needs a shell feature (a real pipe)?
5. Output bounding parity: does `execFile` output flow through the same
   truncation/streaming the Bash path uses?
6. Is there an even simpler durable fix than a new tool — e.g. reusing an
   existing structured dispatcher (`mcp_call_tool`, guided action preview) rather
   than adding `capability_run`?

## Critique (Codex, read-only, 2026-08-11)

**Verdict: the structured dispatcher is the right and simplest durable direction —
but the naive `execFile(exe, args)` sketch above is not implementation-ready.**
Required corrections:

1. **Validate argv against the reviewed capability scope — a pinned executable
   alone is insufficient.** CLI flags can alter config, files, plugins, or
   network targets with no shell syntax at all (`--config`, `--output`,
   `--plugin`, `--account`). The host must match the exact argv against at least
   one reviewed pattern for that capability and reject excess arguments, NULs,
   oversized input, and unreviewed subcommands/flags — after confirming the
   capability matches current app/agent/person authority.
2. **Represent allowed argv structurally**, not via shell-like `commandTemplates`
   indefinitely.
3. **Execute inside the existing sandbox boundary**, not as an unrestricted host
   process.
4. **Specify the full execution contract**: invocation-time hash verification,
   environment, cwd, stdin, timeout, cancellation, process-tree cleanup, audit
   redaction, and bounded output.
5. **Output bounding is NOT automatic** with `execFile` — it buffers and does not
   inherit the Bash/MCP truncation, streaming, timeout, or cancellation. Route
   the result through the existing MCP result-boundary logic or a bounded stream.
6. **Remove the capability-derived `RunCommand` projection at cutover** — do not
   dual-run (side effects); cut over atomically, update guidance, let existing
   scheduled jobs inherit the new path. A genuine pipe becomes a separately
   reviewed composite capability, not shell.
7. **The doc's claim that hash/sandbox controls are "applied by the host at
   invocation, as today" is unsupported** — the hash field exists but the
   reviewed paths show no invocation-time verification. Address executable
   replacement / TOCTOU via a host-controlled content-addressed executable or
   equivalent immutable identity.
8. Simpler alternative check: neither `mcp_call_tool` nor guided-action preview
   fits (one is a generic proxy, the other read-only). One structured capability
   dispatcher remains the smallest coherent solution.

## Implementation review findings — CLIRUN-1-1 (must fix before stage-done)

Local autoreview (codex gpt-5.6-sol high) of the CLIRUN-1-1 diff surfaced two
real, verified findings. The diff is NOT committed until these are fixed.

1. **[P1] TOCTOU: bind execution to the verified bytes.**
   `resolveGrantedLocalCliInvocation` hashes the file at `executablePath`
   (`structured-local-cli-invocation.ts` `verifyExecutableIdentity`), then the
   sandbox spawns the SAME path string separately. A writable executable or a
   symlink in its path can be swapped between verify and spawn, running
   unverified bytes with the capability's credential-read paths and network
   allowance. Fix: execute an immutable verified copy or fd — e.g. copy the
   executable to a private per-invocation temp (dir 0700, file 0500), verify the
   copy's hash, spawn the copy, clean up; or reject executables whose identity
   cannot be made immutable across verify+spawn. Must integrate with the sandbox
   provider's path access.

2. **[P2] Cancel host execution when the MCP request expires.**
   `ipc-capability-run-handler.ts` passes `new AbortController().signal` that is
   never aborted, and the end-to-end host time (gateway setup + policy resolve +
   hashing + the 120s sandbox timeout) is not bounded below the 125s MCP response
   timeout — so a command can start or keep running after the caller has already
   timed out, and a retry double-applies side effects (`sheets update`). Fix: one
   end-to-end deadline shorter than the MCP timeout; thread the signal through
   `runStructuredLocalCliCapability` into `runSandboxedAsyncCommand` (which must
   abort the child on it); and refuse to launch if setup completes past the
   deadline.

Verdict: the structured-invocation direction and the argv-validation-via-existing-
matcher approach are sound; these two are execution-binding/lifecycle corrections,
not a redesign.

## CLIRUN-1-1 review resolution

Autoreview iterated three rounds on this task; the outcomes:

- **FIXED — TOCTOU execution binding.** The executable is verified and run in
  place at its resolved real path (context-preserving, no relocation), rejected
  if it lives under the agent-writable workspace or is group/other-writable, and
  hash-verified. This closes the swap window the agent can reach.
- **FIXED — timeout/cancellation.** An end-to-end host deadline anchored at
  handler entry (118s, under the 125s MCP timeout) aborts the sandbox, and a
  pre-spawn abort check refuses to launch once the budget is spent — a retried
  mutating capability cannot double-apply side effects.
- **DEFERRED — deep executable-identity hardening (D-0056).** Full parent-
  directory-chain immutability (or fd-binding) against a co-resident local
  attacker, and argv0 preservation for symlinked executables. Both are outside
  the agent threat model and do not affect the pilot; landing the dispatcher on
  the baseline is the smallest safe subset (scope-governor). Revisit per D-0056.
