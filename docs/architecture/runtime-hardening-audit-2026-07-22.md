<!-- doc-references: frozen 2026-07-23 (decision 0036) -->
# Runtime hardening audit — 2026-07-22

External risk-directed audit of tracked `main` at `ddfe0d614` (2026-07-22).
Re-verified against current `main` (`ce61ac1`) on 2026-07-23: **every security and
performance finding below still exists** except the decision-parser finding (see
"Not applicable"). This document is the source of truth for the
`runtime-hardening-audit` roadmap epic; each roadmap item cites the finding here.

Overall risk: **High**. Strong controls exist (API-key scoping, signed ingress,
durable claim fencing, SSRF/DNS-pinning, outbound workspace-file containment), but
three boundary weaknesses (CI runner, inbound attachment writers, LLM concurrency)
and four scalability weaknesses (IPC replay scan, job-list N+1, live-admission
growth, process-local limits) undermine them.

## Findings → roadmap items

Order reflects the client directive: **security and performance first.**

| Item | Sev | Lens | Finding | Status on current main |
|---|---|---|---|---|
| SEC-1 | Critical | Security | PR code executes on the persistent self-hosted CI runner that holds the model key | still exists (`ci.yml:19` self-hosted; key at Agent-E2E step) |
| SEC-2 | High | Security | Inbound Telegram+Slack attachment writers cross the workspace via symlink / check-open race | still exists (no `O_NOFOLLOW`; `telegram-file-download.ts:53,57`, `attachment-download.ts:42-43`) |
| SEC-3 | High | Security | LLM passthrough has no concurrency admission; buffers ≤16 MiB bodies several times | still exists (`llm.ts:72-82` per-minute counter only; loopback hop present) |
| PERF-1 | High | Performance | Every signed IPC request synchronously scans+parses every replay marker | still exists (`ipc-auth-validation.ts:215-224,286-295`) |
| PERF-2 | High | Performance | `GET /v1/jobs` runs one latest-run query per job (≤500 concurrent) | still exists (`job-visibility-metadata.ts:300-304`; no `DISTINCT ON`) |
| PERF-3 | Medium | Performance | SSE stream cap is raceable — checked before the post-`await` increment | still exists (`sessions.ts:389,420,429`) |
| SEC-4 | Medium | Security | Rate limits are process-local; effective limit multiplies by replica count | still exists (`rate-limit.ts:13`, `gantry-model-gateway-rate-limit.ts:19`) — **architecture decision** |
| PERF-4 | Medium | Performance | Durable live-admission has no admission quota and no terminal retention | still exists (`live-admission-work-item-repository.postgres.ts:100-104`; no `ended_at` index/purge) — **architecture decision** |
| CI-1 | Medium | Testing | `check:architecture` is a documented ratchet but is not a CI gate | half-addressed: PAY-1 made the baseline green (exit 0); still absent from `ci.yml` |
| SIMP-1 | — | Simplification | Runtime queue defaults are encoded in three places | still exists (defaults + parser + queue-policy) |
| SIMP-2 | — | Simplification | Control app services are rebuilt per route from global getters | still exists (`routes/jobs.ts:145-167`, `session-interaction-adapter.ts:19-35`) |
| SIMP-3 | — | Simplification | The direct LLM path serializes through a loopback HTTP hop in-process | still exists — pairs with SEC-3 |
| SIMP-4 | — | Simplification | Durable coordination is optional with process-local fallbacks | still exists (`async-tasks.ts:176-184`) — overlaps DUR-1 |

## Dedup / overlap with existing lanes

- **PERF-3 (SSE race)** is a TOCTOU; it fits the existing **CO-2** "coordination
  hardening (locks, TOCTOU, serializer)" batch. Land it there or as its own item,
  but do not duplicate the fix.
- **PERF-4 (live-admission retention)** overlaps **DUR-1**'s deferral **D-0001**
  (data retention). The admission *cap* is new; the *retention* half should be
  reconciled with DUR-1 so retention is defined once.
- **SIMP-4 (mandatory durable coordination)** is the spirit of **DUR-1**; fold it
  into DUR-1 unless it lands sooner as a standalone cleanup.
- **CI-1** relates to **E2E-3** (flip agent-e2e to a required check) — the same
  "make a green checker a required gate" move; sequence them together.
- The **ponytail-audit** lane (`feature/ponytail-audit`) is the schema/cutover
  baseline; it touches some of the same files (`media-ingestion.ts`, `ci.yml`,
  live-admission) for schema reasons and does **not** fix any finding here. SEC-2
  and PERF-4 touch files the cutover moves — sequence after the cutover or rebase.

## Not applicable on this repo

- **Decision-status parser** (audit finding #10): the audit assumed decisions use
  bold-prose `**Status: accepted**`, but the current corpus uses lowercase YAML
  frontmatter `status: accepted` on line 2, which the parser's
  `re.search(r"status:\s*(\S+)")` matches. `./forge decision list --active` does
  **not** hide accepted decisions here. Optional hardening only (fail-loud on an
  unparseable status), not tracked as a goal.

## Confirmed findings (detail)

The full per-finding detail — execution path, evidence, abuse scenario, impact,
minimal fix, and verification — is preserved verbatim from the audit in the
project record. Each roadmap item's `source_refs` points back to this document;
per-story goal-prompts (authored at planning time) restate the minimal fix and the
adversarial verification the audit specifies. Highlights of the mandated
verification per item:

- **SEC-1** — authorized canary PR proving PR code cannot persist a marker/process
  /binary/Docker object observable by a later trusted job; secret-bearing workflow
  checks out only the trusted SHA.
- **SEC-2** — real-filesystem tests: existing final-file symlink, final-file swap
  during open, ancestor swap, hard links, streaming + buffered paths; assert the
  outside target is never truncated/unlinked. Reuse the descriptor-containment
  pattern from `workspace-message-attachment.ts` (a reader today) as one shared
  hardened writer for every inbound channel.
- **SEC-3** — hold upstream behind a barrier, submit more than the cap, prove only
  the allowed number begin body consumption; measure RSS and open sockets under
  concurrent max-size requests; exercise disconnect/malformed/credential/timeout/
  streamed-cleanup paths. Release the permit in one `finally`.
- **PERF-1** — prepopulate 5k/20k markers; assert one validation performs a bounded
  number of FS ops with stable latency; keep replay-rejection-after-restart.
- **PERF-2** — instrument SQL count for a 500-job request; require a constant small
  number of queries (batch `DISTINCT ON (job_id)` / window fn).
- **PERF-3** — barrier + 26 concurrent requests; prove exactly 25 admitted, rest
  `429 TOO_MANY_STREAMS`; permit returned once on failure/disconnect.
- **SEC-4 / PERF-4** — require an architecture decision first (cluster-authoritative
  store vs declared-singleton; admission-cap + retention ownership).

## Rejected hypotheses (do NOT re-open)

Control-API auth fail-open; external-ingress replay/cross-method; raw-signature
retention; webhook DNS-rebinding SSRF; remote-MCP rebinding; outbound-attachment
traversal; missing job latest-run index; concurrent live-admission double-claim;
missing model-gateway upstream timeout; SSE race generalizing to the wait route —
all inspected and **rejected** with evidence in the audit. The accepted concerns
are narrower (fanout, occupancy, retention), not these.
