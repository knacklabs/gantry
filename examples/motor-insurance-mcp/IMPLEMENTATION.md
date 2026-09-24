# MIA + motor-insurance server implementation map

The runnable server is in this directory. Gantry's agent runtime, attachment-copy tool, review notification tool, and Slack decision handler live in the main repository. See [README.md](README.md) for fresh-checkout setup.

## Current local configuration snapshot (2026-09-24)

These names describe the working local example; IDs are installation-specific and must not be copied to another Gantry instance.

| Surface                              | Local value                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP transport                        | Streamable HTTP, `http://127.0.0.1:14319/mcp`                                                                                                                                                                   |
| MCP customer source                  | `Motor Insurance Customer V2`, medium risk, loopback host                                                                                                                                                       |
| Customer MCP tools                   | `list_demo_scenarios`, `get_motor_policy`, `check_motor_coverage`, `find_cashless_garages`, `get_renewal_quote`, `register_motor_claim`, `get_motor_claim`, `ingest_claim_document`, `assess_claim_eligibility` |
| Attached skill                       | `motor-insurance-assistant` (source in `skill/motor-insurance-assistant/SKILL.md`)                                                                                                                              |
| Gantry built-in capabilities         | `notifications.send`, `claims.evidence.store`                                                                                                                                                                   |
| Review channel and outcome route     | `#gantry-demo-insurance-sales`; outcome returns to the originating bound Slack channel                                                                                                                          |
| Review approver                      | `vishwa.anuj` in the local Slack workspace                                                                                                                                                                      |
| MIA working instructions and persona | `agent/mia-instructions.md`, `agent/mia-soul.md` snapshots; import using the Gantry UI                                                                                                                          |

The Gantry runtime reads `MOTOR_INSURANCE_SERVICE_URL`, `MOTOR_CLAIM_EVIDENCE_AGENT_FOLDER`, and `MOTOR_CLAIM_REVIEW_CHANNEL` from its environment. It derives the outcome channel from the originating conversation and records that channel on the review card; `MOTOR_CLAIM_OUTCOME_CHANNEL` is no longer used. `MCP_TOKEN` is optional for loopback and required if the server binds beyond loopback; do not commit it. Gantry's `settings.yaml` is the source of truth for agent source attachment, reviewed capability selections, and conversation bindings. Source attachment does not grant tool authority.

## Flow and code ownership

1. MIA collects only facts from the current new-claim intake, checks policy and coverage through MCP, and creates a draft after explicit confirmation. The server returns `awaiting_documents`; it changes the claim to `submitted_for_review` only after storing a damage photo and either a repair estimate or a filled claim form. The current fresh-intake boundary is in MIA's instructions; it is advisory, not a deterministic backend state machine. Existing form-rendering behavior is unchanged.
2. A customer uploads an image or PDF. Gantry reads the attachment for MIA; `claim_evidence_store` copies the original bytes to this server's `/evidence` endpoint. The model sends only an opaque attachment reference plus unverified extracted text and fields.
3. This server stores claim/evidence metadata in `demo-state.json` and original evidence in `claim-evidence/`. Those paths are local private data, not part of Git.
4. Gantry's `send_notification` in `apps/core/src/application/core-tools/send-notification.ts` checks the claim and stored evidence, then posts a review card to the configured internal channel. The server's `/claims/:claimId/review-card-sent` endpoint records that handoff. A photo plus either an estimate or a filled claim form is accepted for preliminary review; an absent estimate is flagged, not treated as final approval.
5. The Slack action handler in `apps/core/src/channels/slack/channel-message-action-handler.ts` routes a configured human approver's decision through Gantry to this server's `/claims/:claimId/decision` endpoint, then sends the outcome to the configured channel. “Accept for assessment” is not a payout decision.

## Verification

Run `npm ci --ignore-scripts && npm test` in this directory. The smoke test uses its own temporary state/evidence directory, checks MCP tools, evidence types, auth, decision flow, idempotency, and restart persistence; it does not alter a live claim. In the main repo, run the focused Gantry notification and claim-review tests before deploying integration changes.

## Still needed for non-simulation use

- Deterministic new-claim intake state if instructions alone are insufficient to prevent reuse of earlier facts.
- Structured comparison of document policy, vehicle, incident date, and amount against the registered claim, with a human exception workflow. The current review card warns about missing or unverified evidence but does not validate those fields itself.
- Managed storage, access controls, audit, backup/restore, retention/deletion policy, and review of all sensitive-data paths. This JSON-file server is single-process and must not be used for real customer records.
