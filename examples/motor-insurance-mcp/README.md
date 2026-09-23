# Motor insurance MCP example

A standalone MCP server with sample Indian motor-insurance records, a MIA skill, and agent prompt snapshots. It does not connect to an insurer, Gantry Postgres, payments, or real customer records. The Gantry-side notification, evidence-copy, and Slack approval code is in `apps/core` on this branch—not in this server.

## Run from a fresh checkout

Use Node 20 or newer. From this directory:

```bash
npm ci --ignore-scripts
npm test
npm start
```

Check `http://127.0.0.1:14319/health`; the MCP URL is `http://127.0.0.1:14319/mcp`. Do not start a second copy on port 14319. The server stores new claims in `demo-state.json` and original evidence under `claim-evidence/` here by default; both are gitignored. If reproducing an existing claim history is necessary, transfer those two paths together through a separate access-controlled backup. They are not part of this example.

## Connect MIA in Gantry

1. In **MCP servers**, connect an HTTP source at `http://127.0.0.1:14319/mcp`. Give the customer source these allowed tool names: `list_demo_scenarios`, `get_motor_policy`, `check_motor_coverage`, `find_cashless_garages`, `get_renewal_quote`, `register_motor_claim`, `get_motor_claim`, `ingest_claim_document`, `assess_claim_eligibility`.
2. Review the source, attach it to MIA, and select its reviewed MCP capability for MIA. Attachment only makes tools visible; capability selection grants use. `register_motor_claim` and `ingest_claim_document` write local state. Do not attach the internal ticket tools to the customer agent.
3. Create a ZIP from `skill/motor-insurance-assistant/` and upload it in **Skills**; attach it to MIA. Import the text from `agent/mia-instructions.md` into MIA's **AGENTS.md** editor and `agent/mia-soul.md` into its **SOUL.md** editor. Replace the two Slack channel names in the AGENTS.md snapshot with your own review and outcome channels before saving. The files here are snapshots; Gantry's saved UI versions are the active ones. Do not copy this machine's skill, MCP, or agent IDs—Gantry creates new IDs in each installation.
4. Select Gantry's built-in `notifications.send` and `claims.evidence.store` capabilities for MIA. These are not MCP server tools. Set `MOTOR_INSURANCE_SERVICE_URL=http://127.0.0.1:14319`, `MOTOR_CLAIM_EVIDENCE_AGENT_FOLDER` to MIA's local agent folder, and `MOTOR_CLAIM_REVIEW_CHANNEL` / `MOTOR_CLAIM_OUTCOME_CHANNEL` to the destination channel names in Gantry's runtime environment. Restart Gantry after changing its runtime environment.
5. Install MIA in the customer and internal-review Slack channels. Configure the intended human approver on the review conversation. The review card goes to the review channel; its decision outcome goes to the outcome channel. Verify a new claim, evidence upload, review card, and human decision end to end before relying on the flow.

To build the skill ZIP from this directory:

```bash
cd skill
zip -r motor-insurance-assistant.zip motor-insurance-assistant
```

For a separate internal-team agent, `skill/motor-insurance-internal/` provides optional instructions. Grant only `list_claim_tickets` and `get_claim_ticket` on a separate reviewed MCP source. Access is agent-wide across its channels; a channel name does not isolate tools.

The loopback URL works only when Gantry runs on the same host. A container or remote Gantry backend needs an endpoint it can reach. For a separate host, use HTTPS with `MCP_TOKEN` and `HOST=0.0.0.0`, and configure the matching bearer credential in Gantry. Binding beyond loopback without a token is refused. Do not expose the evidence and decision endpoints publicly or load real customer information.

## Demo data and questions

Simulation clock: **2026-09-23**, independent of your real calendar.

| Policy     | Customer / vehicle  | Scenario                                                                           |
| ---------- | ------------------- | ---------------------------------------------------------------------------------- |
| MOTOR-1001 | Aarav Demo / Baleno | Active comprehensive, zero depreciation, roadside assistance, no engine protection |
| MOTOR-1002 | Meera Demo / i20    | Active third-party only; own vehicle damage excluded                               |
| MOTOR-1003 | Kabir Demo / Nexon  | Expired 2026-08-31                                                                 |

Try these prompts:

- “What is my deductible and IDV for MOTOR-1001?”
- “Does MOTOR-1001 cover engine water damage from yesterday's flood?”
- “I scratched my car yesterday. My policy is MOTOR-1002. Is it covered?”
- “Can I claim for an accident on 20 September under MOTOR-1003?”
- “Find cashless garages in Bengaluru.”
- “Find a garage in Chennai.” (No matches; the agent should not invent one.)
- “Compare MOTOR-1001 renewal with and without engine protection.”
- “What documents are pending for CLM-DEMO-001?”
- “Register a bumper collision for MOTOR-1001 on 22 September 2026 in Bengaluru. I hit a pillar while parking.” Then confirm when asked.
- “Check the status of the claim you just created.”
- “I uploaded a fictional repair estimate PDF for MOTOR-1001. Read it and store the extracted text for CLM-DEMO-001.”
- “Can I claim for a collision on 22 September 2026 under MOTOR-1001?”
- Internal agent: “List current claim tickets and show me the documents for CLM-DEMO-001.”
- “Approve my claim and pay me now.” (Unsupported; no invented approval.)

## Behavior and limits

Eleven tools: `list_demo_scenarios`, `get_motor_policy`, `check_motor_coverage`, `find_cashless_garages`, `get_renewal_quote`, `register_motor_claim`, `get_motor_claim`, `ingest_claim_document`, `assess_claim_eligibility`, `list_claim_tickets`, `get_claim_ticket`.

The claim evidence flow is **Slack image/PDF → Gantry attachment storage → MIA reads the attachment and extracts readable details → Gantry's `claim_evidence_store` copies the original bytes to the insurance server**. The agent passes only an opaque attachment ID, claim ID, document type, and unverified extracted details; binary/base64 never goes through the model. The original is saved under the private `claim-evidence/` directory. PDF text can be extracted by Gantry; image interpretation requires a vision-capable model. An unreadable file can still be retained for human review. The older `ingest_claim_document` MCP tool remains available for text-only intake.

Claims, evidence metadata, and decisions persist to `demo-state.json` beside the server; original files persist separately in `claim-evidence/`. Retries use stable request IDs to avoid duplicate evidence or decisions, including after a restart. This is a single-process mock; do not run multiple processes against the same state file. Back up both the JSON and evidence directory together. The server's HTTP evidence/decision endpoints are intended only for the trusted Gantry backend on loopback; do not expose them publicly. A review card can be recorded after a damage photo plus either a repair estimate or a filled claim form (`incident_report`); a missing estimate remains a reviewer caveat, not final claim approval.

New claims store the eligibility assessment and its exact registration reason at creation time. `get_motor_claim`, `list_claim_tickets`, and `get_claim_ticket` return that saved reason, so staff can explain why the claim was sent for review without recalculating it under later rules. Claims created before this field existed may have a null or absent reason; do not invent one. Review is not approval.

Policy facts, pricing, and coverage rules are invented fixtures, not real insurance guidance. Quotes omit taxes and do not update no-claim bonus based on claims. Claims progress only through an authorized human review decision, not automatically. Review approval is not payout approval. No dispatch, booking, purchase, renewal, cancellation or settlement is implemented. Explicit confirmation is required before claim creation. Do not put real personal or insurance data into this local JSON-file setup.

## Test and configure

`npm test` starts its own isolated server, exercises MCP tools, restarts it to verify claim persistence, and removes only its temporary test state.

Environment variables: `PORT` (14319), `HOST` (127.0.0.1), `STATE_FILE` (optional alternate state path), `EVIDENCE_DIR` (optional alternate original-file directory), `MCP_TOKEN` (optional bearer token for local mode, required for network mode).

Transport follows the official [MCP TypeScript SDK Streamable HTTP documentation](https://ts.sdk.modelcontextprotocol.io/server). The lockfile pins the installed dependencies. The skill ZIP contains instructions only; this checked-in directory contains the runnable server. Gantry's live settings, credentials, and prior conversations are intentionally not exported.
