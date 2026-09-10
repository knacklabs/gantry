---
slug: granted-capability-is-visible
title: A granted capability is visible to the agent that holds it
status: confirmed
saved: 2026-09-10T13:24:58+00:00
---

# A granted capability is visible to the agent that holds it

## Why

The KnackLabs lead-maintenance job holds a reviewed grant for
`google.sheets.values.get`, a semantic capability bound to a local CLI. In seven
consecutive runs the agent opened every run by burning failed calls before its
first successful sheet read: an MCP server that does not exist, a tool that does
not exist, then arguments outside the reviewed template. Only the fourth attempt
worked. The job prompt (3,513 characters) never mentions that machinery, so the
probing is the model's own.

The cause is located, and it is not enforcement. A scheduled run never receives a
capability catalog at all. The catalog is built only on the chat path
(`apps/core/src/runtime/group-agent-access-context.ts:44`, consumed at
`apps/core/src/runtime/group-agent-runner.ts:365`); the job path loads the access
snapshot and the semantic capabilities and then omits `capabilityCatalog` from its
spawn input (`apps/core/src/jobs/execution-phases-run.ts:179` and `:287`), while
prompt compilation renders only what that input carries
(`apps/core/src/runtime/agent-spawn-prompt.ts:87`). The job agent is told nothing
about what it holds.

The dispatcher itself was always reachable: `capability_run` is not removed from
autonomous surfaces (`apps/core/src/shared/admin-mcp-tools.ts:96`, filtered at
`apps/core/src/runner/gantry-mcp-tool-surface.ts:152`), and the failing run's own
fourth attempt succeeded through it. What is missing is knowledge, not exposure.

Commit 97ded3746 tried to close this by adding a per-capability block to the
runner's runtime capability context (`apps/core/src/runner/mcp/context.ts:412`).
It deployed and changed nothing, because that context is a different surface from
the catalog the model reads, and on a job run that catalog was empty anyway.

Even on the chat path the catalog is insufficient: its entry shape carries no
invocation data (`apps/core/src/application/agents/agent-prompt-capability-catalog.ts:23`),
and its renderer drops the stable reference and can collapse ready entries into a
summary count (`apps/core/src/application/agents/agent-prompt-capability-guidance.ts:241`),
so a grant can be hidden by overflow or rendered without a usable call shape.

Decision 0158 settles the direction: discovery is the defect, and argv validation
remains the enforcement boundary. Decisions 0120 and 0130 stand unamended, so
nothing here adds a classifier-derived or cached allow to `capability_run` or
relaxes a reviewed template. Decision 0109's ordering consequence was amended so
this ships first.

## Behaviour

**A scheduled run receives a catalog.** It is built from the same access snapshot
the chat path uses, carried on the existing spawn-input field, and rendered by the
same compiler. One builder serves both lanes.

**Every granted capability carries a usable descriptor.** For each grant the
catalog carries its display name, its stable capability id, and the invocation
descriptor its binding kind can support, as a closed union over the runtime's five
kinds:

- `local_cli` — the dispatcher tool name and the reviewed argument patterns.
- `mcp_pattern` — the tool-name pattern the model may call.
- `tool_rule` — the tool name the rule authorizes.
- `skill_action` — the skill action's invocation path, with decision 0129's
  terminal-wildcard semantics preserved; skill attachment stays separate from
  action authority.
- `adapter` — the dispatcher tool name and the capability id, because the adapter
  reference is opaque and must never be rendered.

A kind with no argument schema carries the reachable tool identity and says so,
rather than an invented shape. No secret, path, hash or executable location enters
a descriptor.

**No grant is ever hidden.** The capability guidance section has a default budget
and a stated ceiling, both expressed in characters. Material is shed in a fixed
order: non-granted entries first, then descriptions, then descriptors. Past the
ceiling every grant still renders its display name and stable id, and the render
records an overflow diagnostic on the run's startup event. A grant is never
reduced to a count and never omitted.

**One mechanism owns the job.** The per-capability block added by 97ded3746 is
removed, and the dispatcher's description points at the catalog instead. Its input
schema, risk classification and host enforcement are unchanged.

**Enforcement is untouched.** Argv validation, executable identity, structured
argv with no shell, size and NUL limits, and the sandboxed executor all stay as
0120 and 0130 define them.

## Acceptance criteria

1. A scheduled run's spawn input carries a capability catalog built from its access
   snapshot, proven by a hermetic test over the real job execution path asserting
   the field is populated where it is absent today.
2. The rendered guidance for that run contains, for a granted capability, its
   display name, stable id and invocation descriptor, asserted against the exact
   rendered text.
3. A descriptor is produced for all five binding kinds, asserted per kind, with the
   adapter reference absent from the output and the skill-action path preserving
   decision 0129's terminal-wildcard semantics.
4. With a granted set exceeding the default budget, non-granted material is shed
   first and every grant still renders with its descriptor. Past the ceiling every
   grant still renders display name and stable id, and the overflow diagnostic is
   recorded. No grant is reduced to a count or omitted. Budget and ceiling are
   named constants asserted by the test.
5. A deterministic replay harness drives the runner adapter with a named recorded
   fixture and a stub that selects tools only from the materialization it is given,
   with no live model call. Its first capability attempt is a well-formed
   dispatcher call with no preceding call to a non-existent MCP server or tool. The
   test carries a negative control: with the descriptor removed, the same harness
   does not produce that call.
6. The per-capability block added by 97ded3746 no longer exists; the dispatcher's
   description points at the catalog; and its input schema, risk classification and
   host enforcement are pinned unchanged by test.
7. Enforcement is unchanged: a template mismatch is still refused, no
   classifier-derived or cached allow reaches `capability_run`, and executable
   identity, structured argv, size and NUL limits still apply. The existing proofs
   for 0120 and 0130 stay green.
8. Live smoke, stated separately and explicitly not a merge gate: five serial runs
   of `job-knacklabs-lead-maintenance-43527c192a6e` on the deployed runtime, each
   with at least one successful capability invocation and zero `tool.activity` rows
   with phase `failure` for `capability_run` or `mcp_call_tool` before it. Evidence
   is the per-run event query and the startup diagnostic, retained redacted.
9. Focused proof by name: the capability catalog, capability guidance, agent spawn
   prompt, job execution phases, capability structured invocation and locked
   introspection suites, plus the new replay suite. `npm run typecheck`,
   `npm run lint`, `npm run format:check`, `npm run check:architecture` and
   `verify.py` green.

## Out of scope

Document reading and editing, including slice reads, exact-span replacement,
revision fencing and the persisted job owner, move to their own spec. Relaxing
argv validation stays future direction, gated by decision 0158 on a replacement
boundary that must supersede 0120 and 0130 explicitly.
