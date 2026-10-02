---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-01T18:22:39+00:00
read_hash: 20b2c0e07bd60211726c45508e976af82c1ba38a
round: 2
passed: no
doc_seen: 20b2c0e07bd60211726c45508e976af82c1ba38a
spec_seen: 4edda298df1c470d20c40e288fd906d0cad5511b
notes_seen: 16fce2271eb20aa8baae860d69855579dd97441b
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. Unproven: items 1–2: hard rules and admin asks must win over existing approvals.
   `coordinatePermissionDecision` returns a non-family reviewed-rule allow before evaluating deterministic rails. Assign the ordering change to T1 and add gate cases with matching saved approvals and cached/classifier allows, including every admin action required by spec AC6.
   Disposition: cut

2. Contradiction: item 2 sends short inline scripts to the judge while its builder details and confirmed spec hard-stop inline interpreter code.
   Align Risks with the confirmed interpreter rule. Otherwise builders receive opposite instructions for calls such as `python -c …`.
   Disposition: cut

3. Item 2 cannot safely summarise truncated input through the scoped classifier change alone.
   `runtime/ipc-parsing.ts` truncates the input before the rails and classifier receive it. T3 must own the producer of a summary derived from the complete action, with hard-boundary evaluation before information is discarded. Add cases with danger and paths beyond the truncation boundary, plus separate missing/malformed-input cases.
   Disposition: cut

4. Item 2 leaves the outcome of a command-template mismatch undefined.
   `jobs/structured-local-cli-invocation.ts` refuses unmatched arguments before spawning; reporting once in the handler does not stop repeated refusals. Pin whether the exact invocation proceeds through the normal gate or requires a reviewed amendment, preserving executable verification and sandbox restrictions. Scope the execution owner and test repeated mismatches, restart, approval and denial.
   Disposition: cut

5. Required production edits fall outside their owning tasks’ scopes.
   T3 promises to remove `mergeIpcClassifierWithRail`’s veto, but its file is scoped only to T1. T1 names nonexistent `application/permissions/judge-outage.ts`; the cache writer is in `runtime/permission-judge-outage.ts`, currently scoped only to T5. Correct ownership and have T1 pin the classifier cache read/write key before later tasks use it.
   Disposition: cut

6. T2 and T5 lack a shared identity for one invocation appearing under two tool names.
   The IPC client creates a fresh permission UUID, and `pendingInteractionIdempotencyKey` keys records by that request ID. Canonicalising `mcp__gantry__` names alone cannot distinguish a duplicate gate entry from a second legitimate call. T1 must pin the invocation identity carried by T2 and consumed by T5; test both situations.
   Disposition: cut

7. Unproven: item 3: changing button labels does not establish their decision semantics.
   `permissionCardDecisionOptions` currently maps “No” to `remember_deny_exact`, while the confirmed spec says Deny is never remembered. Pin the action-code mapping for scalar and card prompts, including each current save target and the nothing-to-save exception. T4 needs interaction/persistence proof alongside rendering tests.
   Disposition: cut

8. T4 must specify removal of batching, rather than only removal of batch labels.
   `decisionForPermissionInteraction` maps batch `allow_persistent_rule` to “review each”, without saving approval. Relabelling it “Allow for future” would be false. The smallest shape is individual prompts; pin that delivery behavior for T5 and test simultaneous asks with independent answers.
   Disposition: cut

9. Unproven: item 3: prompt specifics and the request’s reason survive restart.
   The confirmed spec requires readable details after restart, but `durablePermissionRequestSnapshot` omits ordinary `toolInput`, `displayName` and `turnIntentSummary`. Add its owning file to scope, pin which sanitised display fields persist, and test recovery without losing the details or exposing secrets.
   Disposition: cut

10. Item 4 cannot deliver in-place settlement on every channel within T5’s scope.
    `channels/discord/permission-prompt-settlement.ts` deletes approved prompts and is excluded. Scope that owner and prove settlement, including edit failure without an extra message. T5 also lacks the named real-runtime end-to-end case required by the repository’s testing rules for this user-visible behavior.
   Disposition: cut

11. Unproven: item 4: the resend limit and both-copy answers survive repeated crashes.
    A single crash-after-send count does not prove the durable resend budget or either copy settling the same ask. Name cases for another crash during the resend, concurrent answers, a lost message locator and an already-settled ask. Scope the actual binding/recovery owners, rather than only their re-exporting durability facade.
   Disposition: cut

12. Split: T2 → runner-client/check consolidation, then engine gate coverage.
    Deleting `permission-callback.ts` alone changes 574 lines, before modifying the Claude runner, DeepAgents tools and inline lanes. Put consolidation first; let the second task own the engine decision table and `deepagents-gantry-tool-gate` test.
   Disposition: cut

## Round 2

13. T2’s client deletion leaves a production importer outside its scope.
    `anthropic-claude-agent/runner/job-heartbeat.ts` imports `inFlightPermissionRequests` from the deleted client; the neutral client has no equivalent export. Scope the heartbeat adaptation and prove that a job waiting for permission still reports its pending request.
   Disposition: cut

14. Item 4 still excludes the recovered Telegram prompt’s settlement owner.
    `channels/telegram/permission-callback.ts` deletes approved prompts after recovery and sends a new receipt when editing fails. T6 scopes only the live settlement file. Include the recovery owner and test approval after restart plus edit failure without another message.
   Disposition: cut

15. The route guard runs too late to enforce the confirmed spec’s missing-binding refusal.
    The revised ladder can return a saved or cached allow before entering the tail, where the route guard lives. T1 must validate the conversation route before those shortcuts, for chat and jobs alike. Add missing/removed-route cases with matching approvals and cached allows.
   Disposition: cut

16. Unproven: item 1: moving the memory-boundary check preserves its host-owned evidence.
    `denyMemoryBoundaryToolUse` depends on the run’s suppressed-memory marker, but the host IPC gate and registered run restrictions do not carry that state. T1 must pin its trusted source and scope the producer; add behavioral refusal coverage before T2 removes the runner check.
   Disposition: cut

17. Unproven: items 1–2: shell shapes reach the classifier under every supported permission mode.
    `consultPermissionClassifierBeforePrompt` skips `ask` mode, and its `auto_strict` branch asks without consulting when deterministic read-only proof fails. Name the treatment of these existing modes and include them in T3’s engine matrix and T4’s shape cases; removing the rail veto alone does not satisfy item 2.
   Disposition: cut

18. Unproven: items 1 and 4: invocation identity cannot reuse another run’s answer.
    T1 must pin the authenticated run/app/agent scope of an engine-supplied ID and reject reuse with a different action. Add cases for the same ID in different runs, changed arguments under one ID, and missing/malformed IDs. The current tests distinguish aliases and separate IDs only.
   Disposition: cut
