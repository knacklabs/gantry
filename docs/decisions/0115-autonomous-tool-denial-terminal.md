---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-07
stories: [SCHED-6, JOBFLOW-1]
---

# Autonomous Tool Denial Terminal

## Context

In a scheduled (autonomous) job, a "non-promptable" tool denial resolved as a soft
deny: `denyNonPromptableAutonomousRecovery` returned `{ behavior: 'deny',
interrupt: false, terminal: false }`, handing the model a "no" and letting it
silently continue with a different tool (e.g. Browser) and finish the run green.
No pause, no approval prompt, no notification — so a job could spend its whole
run doing the wrong thing, and the owner never knew to fix it. This contradicts
the stated architecture (`docs/architecture/autonomous-jobs.md`: an under-declared
job that reaches a denied tool should pause) and was the source of real time/token
loss. Verified by three independent Codex read-only passes.

## Decision

An autonomous-job tool denial is **terminal** — it never silently continues. The
run ends and the job routes to the setup-pause (awaiting-approval) state. A
**grantable** denial raises the standard approval card naming the specific tool
(one tap grants it to the agent; for an under-declared tool the same human tap
also adds it to the job's `access_requirements`), then the job retries. A
genuinely **non-grantable** denial (locked-preset, fixed-image, protected path,
unmatched command, unreachable MCP) ends with a legible instruction card naming
the tool and why it cannot be granted. The synchronous zero-timeout autonomous
permission protocol is unchanged; only the deny result's terminality and routing
change.

Decision 0126 supersedes the blanket scope wording above. Declarative-rule denials are
terminal on scheduled runs, including the DeepAgents protected-capability, memory-boundary,
and settings-denylist guards and the Anthropic protected-capability and memory-boundary
guards. The only excluded Anthropic guards are model validation, wait-only, and network.
`JOB_TOOL_DENIED` is the required typed durable source of terminal-denial truth and is
appended before finalization; a recognized capability-template mismatch carries the
`fix_proposal` action defined by decisions 0125 and 0127.

Decision 0127 supersedes the `grantable`/`non-grantable` boolean split in this record with
the tagged `approve_grant`, `fix_proposal`, or `instruction` action union. Eligibility and
card behavior derive from the action variant rather than a boolean.

## Consequences

- The run that hit the denial is a failed run; its partial work is lost
  (approve-and-retry, not resume-the-exact-call) — accepted as far better than a
  silent wrong completion.
- A denied-tool pause must NOT consume a retry/backoff attempt or count toward
  dead-letter: a job waiting for approval never dead-letters from waiting, and a
  late grant (minutes or days) resumes and reruns it fresh.
- Adding an under-declared tool to a job on approval is a human-initiated edit
  (the approver acting on the card), not the autonomous run mutating its own job,
  so it stays within decision 0106 (scheduled runs cannot self-mutate).
- The current tests that assert "denied without pausing" are deliberately updated.
- In the DeepAgents lane, the neutral pre-check denials (protected-capability,
  memory-boundary, settings yolo-denylist) are also terminal on a scheduled run:
  they route through the same onPermissionDenied handler with grantable:false and
  a legible instruction card, so no scheduled DeepAgents tool denial can silently
  let the model substitute another tool. (Folded in on Ravi's "fix once for good"
  direction; supersedes the earlier deferral D-0051.)
- The Anthropic model-validation, wait-only, and network guards remain outside the terminal
  sweep. Decisions 0126 and 0127 supersede all broader scope and grantability wording above.
