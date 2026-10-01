---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-01T12:14:06+00:00
read_hash: f8c4a8f3ca3638de863c427218719e7e6e65399b
round: 4
passed: yes
doc_seen: f8c4a8f3ca3638de863c427218719e7e6e65399b
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: 7b25c59233d2863895bfdb70d6453099c6c8661f
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. Approval precedence contradicts AC2 and AC3.
   Remembered approvals precede the classifier, but another line requires the classifier to check every call. Pin whether a matching approval ends evaluation or whether the classifier can ask again, and when a stricter check invalidates it.
   Disposition: cut

2. AC3 does not define what a program approval authorizes inside a compound command.
   Approving `gh` must not also approve the second program in `gh … && other-program …`, a command substitution, or a pipeline. Pin executable identity, wrapper handling, redirection effects and fail-closed handling of unparseable input. State which shells are supported; “whatever shell form” currently has no boundary.
   Disposition: cut

3. “Allow once” pins duration but not authority, and Deny has no defined outcome.
   Specify which action subsequent calls may reuse within the turn or run. Also decide whether Deny rejects only that call or ends the run, whether it is remembered, and what the next scheduled run does. Admin actions must still ask individually.
   Disposition: cut

4. AC2’s deadline is undefined for one-time and manually triggered jobs.
   Both exist in the repository and have no next scheduled occurrence. Pin their wait lifetime and what happens when a waiting recurring job is rescheduled, paused or deleted.
   Disposition: cut

5. Unproven: item AC2: approval racing with the next scheduled occurrence or a worker restart.
   Specify how the old prompt becomes inactive before replacement work starts, what a late click tells the user, and how duplicate callbacks and recovered workers avoid executing the approved call twice. Extend the lifecycle proof through real runtime and Postgres.
   Disposition: cut

6. Sharing the chat runner leaves conversation scheduling undefined.
   The current queue serializes active work per conversation lane. Pin whether a waiting job blocks ordinary chat and other jobs, or how incoming messages interact with it. Prove that fresh job sessions preserve the conversation’s interactive session and memory boundaries.
   Disposition: cut

7. Approval ownership and unavailable routing need explicit failure behavior.
   Conversation scope does not establish who may approve in a group. Preserve conversation approval policies and app/account isolation; pin behavior when the approver, conversation binding or delivery route is missing or revoked. These cases need fail-closed coverage in the gate and lifecycle tests.
   Disposition: cut

8. Friendly names alone do not provide inspectable approval details.
   “Read Google Sheets values” does not identify the sheet or account, and a program name does not describe its proposed effect. Preserve redacted action details, including after restart. Also define what “Allow for future” means for native tools without a named capability or program; the promised three-button prompt currently has no valid saved target for them.
   Disposition: cut

9. The irreversible cutover has no stated risks or disposition of existing state.
   Existing approvals have different scopes, jobs can be paused for setup, and delivery can use multiple routes or silent mode. Pin the one-time treatment of those records and settings without broadening old approvals or silently stranding jobs. Record deletion and approval loss under Risks; compatibility paths are unnecessary.
   Disposition: cut

10. Unproven: item AC3: live approval changes and isolation.
    The stated criterion tests the next run, while Behaviour promises applicability to the next call. Name proof for a grant added during a run, another agent in the same conversation, and another conversation. Include the compound-command negative cases from finding 2.
   Disposition: cut

11. Unproven: items AC4 and AC5: admin refusal and normal reply delivery.
    AC4 needs proof that remembered authority and a classifier allow cannot bypass an admin ask or enable future approval. AC5 needs an automated runtime test for reply/history/thread placement and a single credential-failure notice, including delivery recovery.
   Disposition: cut

12. Unproven: item AC6: retention and bounded maintenance.
    “A set time” supplies no retention period, and “only waiting rows” still permits an unbounded pending backlog. Pin retention, bounded sweep sizes and protection of active waits and undelivered results. Use Postgres proof covering aging, cleanup and waiting-only queries; 1,000 runs alone does not prove retention.
   Disposition: cut

## Round 2

13. Finding 2 remains open: program identity and supported shells are still undefined.
    Requiring every program to be covered resolves mixed commands, but not whether trusted `gh` and `/tmp/gh` share approval, or how wrappers and substitutions identify programs. Pin these boundaries and supported shells in AC3’s proof.
   Disposition: cut

14. Program-wide classifier caching turns a machine judgment into broader authority.
    An allow for `gh issue view` would cover `gh issue create` without judging its different effect, although no person approved future use. Reuse the existing effect-based verdict cache; reserve program-wide authority for explicit human approvals.
   Disposition: cut

15. Tool-level fallback approval can accidentally authorize an entire dispatcher.
    With `mcp_call_tool` and inline dispatchers entering the gate, “covers the tool itself” could cover every downstream action. Pin approval to the resolved server/tool or capability, and test that approving one target cannot authorize another.
   Disposition: cut

16. AC8’s migration promise contradicts the new approval format.
    An exact-command approval cannot become a whole-program approval while remaining “without becoming wider”; Risks explicitly acknowledges that widening. Clarify whether the guarantee concerns conversation scope only. Also pin migration targeting when an existing job has multiple result conversations or an approval lacks its original conversation.
   Disposition: cut

17. AC5’s exactly-one-message guarantee lacks an ambiguous-delivery policy.
    Decision 0124 explicitly handles a crash after a provider accepts a send but before delivery is recorded. This spec replaces that decision without specifying whether recovery reconciles, retries or stops. Pin the outcome and fault-injection proof so recovery cannot silently duplicate or lose prompts.
   Disposition: cut

18. AC9’s constant-state promise conflicts with its retention rules.
    A job generating 1,000 answered prompts within 30 days retains 1,000 records, while permanently undeliverable results accumulate indefinitely. Distinguish bounded active state from retained history, define terminal delivery failure, and test sustained delivery failure as well as aging.
   Disposition: cut

19. Unproven: item AC4: chat continues during a waiting job without changing the chat session.
    Finding 6’s behavior is now specified, but the named end-to-end test still does not include concurrent chat or session isolation. Add those observable cases to the runtime proof.
   Disposition: cut

20. Unproven: item AC4: an approval added during an existing run applies to its next call.
    Finding 10 remains partially open: “after the job was created” can be tested entirely between runs. Explicitly include the live-run case promised by Behaviour.
   Disposition: cut

21. Finding 11 remains open: AC6 and AC7 still have no named proof.
    Specify coverage for admin asks despite saved or classifier authority, and runtime proof for normal reply/history/thread placement and one credential-failure notice, including delivery recovery.
   Disposition: cut

## Round 3

22. Exact carry-over still conflicts with automatic replacement by program approval.
    The doc says “only a new tap creates a program approval,” but later automatically replaces rejected saved approvals with program approvals. That can widen a carried-over exact approval without consent. Preserve its scope or require a new approval.
   Disposition: cut

23. Finding 17 remains partially open: an unknown original prompt cannot reliably be updated.
    A crash can lose Telegram’s returned message ID before persistence. Answering the replacement then cannot update the unidentified original, despite the promise that both copies show the answer. Specify that known copies are updated and an unknown copy is settled when tapped; include this crash boundary in the fault test.
   Disposition: cut

24. AC3’s mandatory asks contradict classifier fallback.
    Behaviour sends uncovered programs and runtime-built commands to the classifier, whose allow must be final. AC3 instead says these “still ask.” Distinguish “not covered by this approval” from “must ask,” and clarify that hard-rule stops take precedence over classifier fallback.
   Disposition: cut

25. The “no repeats” success target counts asks the spec deliberately requires.
    After Allow once, another run must ask again; repeated admin actions and hard-rule cases also ask by design. Define repeats as avoidable asks despite a valid persistent approval, and align the baseline with that definition.
   Disposition: cut

## Round 4

No findings.
