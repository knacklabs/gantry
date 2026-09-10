---
slug: agents-can-use-what-they-are-granted
title: Agents can use what they are granted
status: draft
saved: 2026-09-10T10:57:43+00:00
---

# Agents can use what they are granted

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
deployed and changed nothing, because context prose cannot help a model choose a
tool it cannot see. The model-visible catalog that does reach it
(`apps/core/src/application/agents/agent-prompt-capability-guidance.ts:241`)
renders a display name, category and description, and carries neither the
capability's stable id nor its invocation shape.

Decision 0158 settles the direction: discovery is the defect, and argv validation
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
Both halves apply here. `document_str_replace` and `document_insert` are absent
from scheduled tool surfaces; `document_view` is a read and stays available to a
scheduled run.

## Behaviour

**A granted capability is visible before the first attempt.** The model-visible
capability catalog carries, for every granted capability, its stable capability
id and the invocation shape that reaches it: the dispatcher tool name and the
argument list. That descriptor is present in the initial materialization the
model receives, before its first attempt, in the lane the run executes on, and
independently of whether tool search has loaded anything else. Enforcement is
untouched: argv validation, executable identity, structured argv with no shell,
size and NUL limits, and the existing sandboxed executor all stay exactly as 0120
and 0130 define them. Only the superseded per-capability block added by
97ded3746 is removed; the generic dispatcher tool and its contract stay.

**Documents are read in slices and edited in place.** The contract is a property
of documents, not of a surface. Version one binds exactly one document store, the
scheduled-job prompt; further surfaces are deferred, and binding one later means
registering a store, not writing another tool. Authority-bearing documents are
excluded by construction: an agent may never edit what determines its own access.

The tools, adopting the `memory_20250818` command shape:

- `document_view { document_ref, view_range? }` — `view_range` is `[start, end]`,
  1-indexed and inclusive over lines, `-1` meaning end of document. Returns the
  requested lines, the document's `revision`, and its total line count.
- `document_str_replace { document_ref, old_str, new_str, expected_revision }` —
  replaces one exact span.
- `document_insert { document_ref, insert_line, insert_text, expected_revision }`
  — inserts after the given 1-indexed line.

`document_ref` is a store key, never a filesystem path. It resolves against the
document's canonical owner as decision 0114 defines it, never from a
conversation JID or workspace, and against the acting person as decision 0118
defines it; the existing conversation-derived helper
(`apps/core/src/application/jobs/job-management-access.ts:9`) is not reused. An
unresolvable owner or acting person fails closed. Uniqueness is counted over the
whole stored document, never over the returned slice.

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
revision on conflict.

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

Replacement text is redacted at ingress, before any permission record, transcript
or audit row is written, so submitted secret-shaped text never persists in the
clear. Text that is itself secret-shaped may be written into a document, since a
prompt may legitimately contain one, but it is stored as given and rendered
redacted on every subsequent read.

**Existing authority is preserved.** Where a surface gates writes behind review or
approval, the edit contract routes through that gate rather than around it.

## Acceptance criteria

Runtime scope is the Anthropic worker lane the KnackLabs job runs on; other lanes
are deferred. Document scope is the scheduled-job prompt.

1. The initial model-visible materialization in the worker lane contains, for a
   granted capability, its stable capability id and its invocation shape, proven
   by a hermetic test over the real catalog and tool-materialization path and
   asserted against the exact rendered descriptor, including when the run's
   available-tool count is below its allowed-tool count.
2. A deterministic replay of a recorded run, driven from that materialization
   with no live model call, issues a well-formed call to the granted capability
   as its first capability attempt, with no preceding call to a non-existent MCP
   server or tool. The fixture and the descriptor it asserts are named in the
   test.
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
7. `document_view` returns a requested inclusive line range, the revision, and the
   line count, proven against a prompt over 3,000 characters containing blank
   lines and leading whitespace.
8. `document_str_replace` replaces one exact span and leaves every other byte
   identical, proven against the same document.
9. Absent expected text returns the literal not-found string and the document is
   unchanged.
10. Expected text occurring more than once returns the literal not-unique string
    naming the matching line numbers, counted over the whole document, and the
    document is unchanged.
11. A write carrying a stale revision is refused with the literal stale string and
    the actual revision, proven by two concurrent writers where the loser errors
    and the winner's text survives. The persistence operation is one conditional
    statement matching document identity and expected revision and incrementing
    it in the same transaction, asserted at the repository level. A concurrent
    whole-document `scheduler_update_job` is fenced by the same revision, proven
    by a test that races the two paths.
12. An edit whose expected text overlaps a protected span returns a response
    byte-identical to the not-found response, proven by a test comparing both
    responses; repeated failures on one document are rate-limited; and no error,
    transcript, permission record or audit row contains unredacted bytes.
13. Redaction preserves line coordinates, proven against a document containing a
    multi-line secret where a range read and the stored document agree on line
    numbers.
14. `document_str_replace` and `document_insert` are absent from scheduled tool
    surfaces, and a forged scheduled provenance is rejected by the host. Both are
    tested, per decision 0106.
15. `document_ref` resolution is authority-checked against the canonical owner
    (0114) and acting person (0118), failing closed when either is unresolvable;
    a caller without write authority is refused, and an authority-bearing
    document cannot be addressed at all.
16. The first-match-only replacement at `gantry-facade-tools.ts:485` no longer
    exists in any edit path.
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
