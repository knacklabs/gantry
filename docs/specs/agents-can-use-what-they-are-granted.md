---
slug: agents-can-use-what-they-are-granted
title: Agents can use what they are granted
status: draft
saved: 2026-09-10T12:38:10+00:00
---

# Agents can use what they are granted

> **SUPERSEDED IN PART (2026-09-10).** Everything about capability discovery in
> this document is superseded by `docs/specs/granted-capability-is-visible.md`,
> which is confirmed and owns that work under story GRANTED-1. This document is
> retained only as the draft source for the DOCUMENT edit contract — slice reads,
> exact-span replacement, revision fencing via decision 0108, the persisted job
> owner via decision 0114, and the redaction boundary — which has not yet been
> split out into its own confirmed spec. Do not implement the capability sections
> here; they contain divergent scope and an incorrect binding-kind list.

## Why

Granting an agent access is not the same as making that access usable. Two
surfaces grant something and then leave the agent unable to use it. They look
like separate bugs and share a shape: what the agent was given is not present in
the form the agent actually works in.

**Capabilities: the grant is invisible.** The KnackLabs lead-maintenance job
holds a reviewed grant for `google.sheets.values.get`, a semantic capability
bound to a local CLI. In seven consecutive runs the agent opened every run by
burning failed calls before its first successful sheet read, in a fixed order: an
MCP server that does not exist, a tool that does not exist, then arguments
outside the reviewed template. The job prompt (3,513 characters) never mentions
that machinery.

Only the third failure is a template mismatch. The first two are the model
reaching for shapes it knows because it cannot see the one it has. That run
carried 62 allowed tools but 11 available, with tool search in automatic mode
(`apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.ts:88`).
Commit 97ded3746 added a per-capability block to the runner's runtime capability
context (`apps/core/src/runner/mcp/context.ts:412`), not the system prompt. It
deployed and changed nothing.

The reason is now located. A scheduled run never receives a capability catalog at
all. `capabilityCatalog` is populated only on the chat path
(`apps/core/src/runtime/group-agent-access-context.ts:44`, consumed at
`apps/core/src/runtime/group-agent-runner.ts:365`); the scheduled job path loads
the access snapshot and semantic capabilities but omits the field from its spawn
input (`apps/core/src/jobs/execution-phases-run.ts:179` and `:287`), and prompt
compilation renders only a catalog supplied on that input
(`apps/core/src/runtime/agent-spawn-prompt.ts:87`). The job agent is therefore
told nothing about the capabilities it holds, and guesses.

Even on the chat path the catalog would be insufficient: its entry shape carries
no invocation data (`apps/core/src/application/agents/agent-prompt-capability-catalog.ts:23`),
its renderer drops the stable reference and can collapse ready entries into a
"+N more" summary (`.../agent-prompt-capability-guidance.ts:241`), so a granted
capability can be hidden by overflow or rendered without a usable call shape.

Decision 0161 settles the direction: discovery is the defect, and argv validation
remains the enforcement boundary. Decisions 0120 and 0130 stand unamended, so
this story adds no classifier-derived or cached allow to `capability_run` and
does not relax the reviewed template. Freeing the call shape is recorded in 0158
as direction gated on a replacement boundary, and is out of scope here.

**Documents: the grant is only usable whole.** `scheduler_update_job` replaces a
job prompt wholesale. The flattened 600-character read (GitHub #447) is already
fixed on a held branch
(`apps/core/src/runner/mcp/tools/scheduler-formatters.ts:138`). Three defects
that fix did not touch remain:

- **The read is redacted, so it is unsafe as an edit source.** Redaction is not
  identity: it rewrites `Bearer <token>` to `bearer [REDACTED_SECRET]` and
  `password: x` to `password=[REDACTED_SECRET]`
  (`apps/core/src/shared/sensitive-material.ts:132`). An exact-match edit built
  from a redacted read can fail to match or write the marker over a real value.
- **There is no compare-and-swap.** Job update input carries no expected version
  (`apps/core/src/application/jobs/job-management-types.ts:265`), the update
  service loads then writes (`.../job-management-update.ts:41`), and the
  repository updates by id alone
  (`apps/core/src/adapters/storage/postgres/repositories/canonical-job-repository.postgres.ts:261`),
  so two writers clobber each other silently. Decision 0108 defines
  `definition_revision` but it is not built: the jobs schema has no such column
  (`apps/core/src/adapters/storage/postgres/schema/jobs.ts:20`). Completing 0108
  is therefore owned scope here, not a dependency to assume, and it supplies the
  single revision this contract fences on. No second token is introduced.
- **The one existing edit-by-substring primitive is wrong.** The `FileEdit`
  facade calls `current.replace(...)`
  (`apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-facade-tools.ts:485`),
  replacing the first match with no uniqueness check.

**Editing a job is attended work.** Decision 0106 holds that an unattended
scheduled run may inspect the scheduler but never mutate it, and requires both
halves of its protection: the mutation tools are absent from scheduled tool
surfaces, and the host rejects any mutation whose signed provenance names a
scheduled source (`apps/core/src/jobs/ipc-scheduler-mutation-authority.ts:18`).
Both halves apply to the write tools, through the mechanisms that already
implement them rather than by assertion. `document_view` is a read and joins
decision 0106's explicit scheduled read surface, which this story extends by
naming it there. `document_str_replace` and `document_insert` join the shared
mutation classification the scheduled tool selector removes
(`apps/core/src/shared/admin-mcp-tools.ts:32`, applied at
`apps/core/src/runner/gantry-mcp-tool-surface.ts:152`), and their host handlers
call the same provenance guard
(`apps/core/src/jobs/ipc-scheduler-mutation-authority.ts:6`). `document_view` is a
read and stays available to a scheduled run.

## Behaviour

**A granted capability is visible before the first attempt.** A scheduled run
receives a capability catalog built from the same access snapshot the chat path
uses, carried on its spawn input and rendered by the same compiler. For every
granted capability the catalog carries the stable capability id and the invocation
descriptor its binding kind can support, as a closed union: a local CLI binding
carries the dispatcher tool and its reviewed argument patterns; an MCP pattern
binding carries the tool-name pattern the model may call; a tool-rule binding
carries the tool name; an adapter binding carries the dispatcher tool and the
capability id, because its reference is opaque and must never be rendered. Kinds
that have no argument schema carry the reachable tool identity and say so, rather
than an invented shape.

A granted capability is never invisible. The guidance section budget is computed
from the granted set rather than fixed, up to a stated ceiling. Non-granted
material is dropped first, then descriptions are truncated, then granted entries
render in compact id-plus-descriptor form. Past the ceiling every granted id still
renders without its descriptor, and the render records an overflow diagnostic. A
grant is never reduced to a count and never omitted. That descriptor is
present in the initial materialization the model receives, before its first
attempt, independently of whether tool search has loaded anything else. Enforcement is
untouched: argv validation, executable identity, structured argv with no shell,
size and NUL limits, and the existing sandboxed executor all stay exactly as 0120
and 0130 define them. The per-capability block added by 97ded3746 is removed, and the dispatcher's
description text is updated to point at the catalog instead of the deleted block.
Its input schema, risk classification and host enforcement are unchanged and
pinned by test.

**Documents are read in slices and edited in place.** The contract is a property
of documents, not of a surface. Version one binds exactly one document store, the
scheduled-job prompt; further surfaces are deferred, and binding one later means
registering a store, not writing another tool. Authority-bearing documents are
excluded by construction: an agent may never edit what determines its own access.

The tools, adopting the `memory_20250818` command shape:

- `document_view { document_ref, view_range? }` — `view_range` is `[start, end]`,
  1-indexed and inclusive over lines, `-1` as the end meaning end of document.
  Omitted means the whole document. A start below 1, a start past the line count,
  or a start greater than the end is an error naming the document's bounds. An
  empty document has zero lines and returns empty content with its revision.
  Returns the requested lines, the document's `revision`, and its total line
  count.
- `document_str_replace { document_ref, old_str, new_str, expected_revision }` —
  replaces one exact span and returns the new revision.
- `document_insert { document_ref, insert_line, insert_text, expected_revision }`
  — inserts after the given 1-indexed line; `0` prepends and is the only valid
  insertion point in an empty document; a line past the last is an error naming
  the bounds. Returns the new revision.

Every mutation returns the revision it produced, so an agent can chain edits
without re-reading.

`document_ref` is an opaque store key of the form `job:<jobId>#prompt`, never a
filesystem path and never itself a source of authority. It is discovered from the
job read that already returns the job, so an agent never constructs one blind.

Authority is resolved host-side, and read and write are separate. Reading a
document requires the job read authority a caller already has. Writing requires
write authority over the job, resolved against the persisted canonical owner
decision 0114 defines, never from a conversation JID or workspace; the existing
conversation-derived helper
(`apps/core/src/application/jobs/job-management-access.ts:9`) is not reused. 0114
is not built either: the jobs schema carries no owner discriminant, so completing
it, migration included, is owned scope here alongside 0108.

Acting-person resolution follows decision 0118 and distinguishes two cases. A job
whose owner is a shared group authorizes an attended write by an acting person the
host records as a member of that group. A lookup that fails to resolve is not
shared scope and fails closed. Uniqueness is counted over the whole stored
document, never over the returned slice.

The write tools are high-risk and ask in normal auto mode, per decision 0107,
rather than inheriting a default classification.

**Failure is loud, literal, and leaves the document untouched.** Absent expected
text returns ``No replacement was performed, old_str did not appear verbatim in
{document_ref}.`` Ambiguous expected text returns ``No replacement was performed.
Multiple occurrences of old_str in lines: {line_numbers}. Please ensure it is
unique.`` A stale revision returns ``No write was performed. {document_ref} is at
revision {actual}; the edit expected {expected}.`` No error echoes the submitted
text back.

**Concurrent edits cannot silently lose work.** A write is one conditional
persistence operation matching document identity and `expected_revision`,
incrementing the revision inside the same transaction, and returning the actual
revision on conflict without writing. The existing whole-document update takes the
same optional `expected_revision`: supplied and stale, it is refused with the
actual revision so the caller can re-read and retry; omitted, it behaves as today
and is fenced only by the run-level rules decision 0108 defines. Every successful
write returns the revision it produced.

**Secrets never round-trip and never leak through probing.** Reads stay redacted,
and redaction preserves line coordinates: a replacement marker occupies the same
number of lines as the span it replaces, so a range read and the stored document
agree on line numbers even when a secret spans lines.

An edit is refused when its expected text overlaps a protected span in the stored
text, detected against the stored text rather than by scanning the request for
markers. That refusal is indistinguishable from the ordinary not-found result:
both return the same literal string, so a caller cannot use the difference as an
oracle for whether a guessed secret is present. Repeated failed replacements on
one document are rate-limited.

Replacement text reaches the document store verbatim, because a prompt may
legitimately contain a credential and corrupting it would be worse than the
truncation this story replaces. Everywhere else it is redacted at ingress: the
permission record, the tool transcript and the audit row each carry the redacted
projection, written before the request is persisted anywhere. The protected
document store is the single exemption, and it is named as such.

Where expected text matches both a protected span and a public one, the protected
match is never counted or reported. The public matches alone determine the result,
so a caller learns nothing about the protected span from the count, the line
numbers, or which error came back.

**Existing authority is preserved.** Where a surface gates writes behind review or
approval, the edit contract routes through that gate rather than around it.

## Acceptance criteria

Runtime scope is the Anthropic worker lane the KnackLabs job runs on; other lanes
are deferred. Document scope is the scheduled-job prompt.

1. A scheduled run's spawn input carries a capability catalog built from its
   access snapshot, proven by a hermetic test over the real job execution path
   asserting the field is populated where it is absent today
   (`execution-phases-run.ts:287`).
1b. The initial model-visible materialization for that scheduled run contains, for
   a granted capability, its stable capability id and a complete invocation
   descriptor, asserted against the exact rendered text, including when the run's
   available-tool count is below its allowed-tool count.
1c. Overflow never hides a grant: with a granted set exceeding the default budget,
   non-granted material is dropped first and every grant still renders with its
   descriptor; past the stated ceiling every granted id still renders without its
   descriptor and an overflow diagnostic is recorded. No grant is ever reduced to
   a count or omitted. Proven for local-CLI, MCP-pattern, tool-rule and adapter
   bindings.
2. A deterministic replay harness drives the runner adapter with a named recorded
   fixture and a stub that selects tools only from the materialization it is
   given, with no live model call. Its first capability attempt is a well-formed
   dispatcher call with no preceding call to a non-existent MCP server or tool.
   The test carries a negative control: with the descriptor removed from the
   materialization, the same harness fails to produce that call, proving the
   descriptor is what causes it.
3. Enforcement is unchanged: hermetic tests assert that a template mismatch is
   still refused, that no classifier-derived or cached allow reaches
   `capability_run`, and that executable identity, structured argv, size and NUL
   limits still apply. The existing proofs for 0120 and 0130 stay green.
4. The per-capability block added by 97ded3746 no longer exists, and the generic
   dispatcher tool and its contract are unchanged.
5. Live smoke, stated separately from the hermetic proofs and explicitly not a
   merge gate: five consecutive runs of job
   `job-knacklabs-lead-maintenance-43527c192a6e` on the deployed runtime,
   triggered serially with no retry between them. Each run must contain at least
   one successful capability invocation, and zero `tool.activity` rows with phase
   `failure` for tools `capability_run` or `mcp_call_tool` before it. Evidence is
   the per-run event query and the run's tool-search diagnostic, retained in
   redacted form on the story.
6. Jobs carry `definition_revision` per decision 0108: a migration adds it, every
   operator-meaningful definition write increments it, runs record the revision
   they claimed, and finalization fences on it. Proven by the tests 0108 names.
6b. Jobs carry the persisted discriminated owner decision 0114 requires, migration
   included, and the conversation-derived access helper is no longer the
   authorization source for any document operation.
7. `document_view` returns a requested inclusive line range, the revision, and the
   line count, proven against a prompt over 3,000 characters containing blank
   lines and leading whitespace. An omitted range returns the whole document, an
   out-of-bounds or inverted range errors naming the bounds, and an empty document
   returns empty content with its revision.
7b. `document_insert` inserts after a given line, prepends at line zero, is the
   only write valid on an empty document at line zero, errors past the last line,
   and returns the new revision. Every successful mutation returns its revision.
8. `document_str_replace` replaces one exact span and leaves every other byte
   identical, proven against the same document.
9. Absent expected text returns the literal not-found string and the document is
   unchanged.
10. Expected text occurring more than once returns the literal not-unique string
    naming the matching line numbers, counted over the whole document, and the
    document is unchanged.
11. A write carrying a stale revision is refused with the literal stale string and
    the actual revision and writes nothing, proven by two concurrent writers where
    the loser errors and the winner's text survives. The persistence operation is
    one conditional statement matching document identity and expected revision and
    incrementing it in the same transaction, asserted at the repository level. The
    whole-document update accepts the same optional expected revision and is
    fenced by it, proven by a test that races the two paths and asserts the
    loser's retry succeeds after re-reading.
12. An edit whose expected text overlaps a protected span returns a response
    byte-identical to the not-found response, proven by a test comparing both
    responses; repeated failures on one document are rate-limited; and no error,
    transcript, permission record or audit row contains unredacted bytes, while
    the document store itself holds the text verbatim.
12b. Expected text matching both a protected span and a public one reports only
    the public matches, proven by a test asserting the count and line numbers
    exclude the protected occurrence.
12c. More than ten failed replacements on one document from one caller within a
    minute return the rate-limit error, and the window expiring restores service.
13. Redaction preserves line coordinates, proven against a document containing a
    multi-line secret where a range read and the stored document agree on line
    numbers.
14. `document_str_replace` and `document_insert` are absent from scheduled tool
    surfaces, and a forged scheduled provenance is rejected by the host. Both are
    tested, per decision 0106.
15. Read and write authority are separate: a caller with job read authority can
    view a document, and only a caller with write authority can change it, proven
    by a scheduled run that can view and cannot write. Write authority is checked
    against the canonical owner (0114) and acting person (0118). A caller without
    write authority is refused,
    an authority-bearing document cannot be addressed at all, a known-absent
    acting person resolves as shared-group scope and permits an attended edit from
    that group, and a failed lookup fails closed. All four cases are tested.
16. The first-match-only replacement at `gantry-facade-tools.ts:485` is corrected
    to refuse an ambiguous match rather than silently editing the first one. That
    facade edits arbitrary workspace files and is out of the bound document scope,
    so it is fixed in place and not migrated to this contract; binding workspace
    files as a document store is explicitly deferred.
17. Focused proof by name: the scheduler tool suite, the capability invocation
    suite, the tool-search decision suite, the capability guidance suite, the
    permission ladder suites, the job revision fencing suite and the new
    document-contract suite. `npm run typecheck`, `npm run lint`,
    `npm run format:check`, `npm run check:architecture` and `verify.py` green.

## Notes

Decision 0153's clauses excluding the classifier from autonomous runs were
amended on 2026-09-10 to match 0157, which supersedes 0121 and puts jobs on the
chat ladder; what survives is the learned-decision projection running before the
ladder. Ladder behaviour is cited from 0043 and 0157. Decision 0156 is the
console deployment decision and is not a ladder citation.
