# Fable Architecture Review — 2026-07-16 (read-only)

Eight subsystem deep-dives; excludes everything already planned (permission
simplification, July-16 audit, conversation quality, E2E, KB, isolation,
agents-as-tools, prompt-lifecycle state machine). Healthy today: runtime-event
exchange, settings-revision protocol, inbound channel normalization, spawn
port, IPC replay protection, the consolidated claim path. Findings ranked by
leverage; sequencing at the end.

1. **One durable-work primitive (cycle, highest leverage).** Leases/claims/
   retry exist in ~10 bespoke copies: 4 parallel lease schemas (run_leases,
   jobs.lease_*, agent_runs.lease_owner, agent_async_tasks fencing hardcoded
   to 1 in jobs/async-command-task-service.ts:575-672) + outbox/webhook/
   admission/artifact claim machines. Five pipelines rebuild claim→heartbeat→
   fenced-write→notify (~most of jobs/ 21k lines). Live bugs today: agent
   send_message is fire-and-forget (runner/mcp/tools/messaging.ts:449) while
   the durable outbound queue sits unused; IPC overload permanently archives
   request files + global in-flight cap lets one agent starve others
   (runtime/ipc.ts:299,438,48). Fix: one work-item helper + claim API over
   run_leases; route send_message durably; overload=defer not archive (small
   fixes shippable first).
2. **Channel interaction engine (cycle).** Four channels re-implement text
   splitting, stream throttling, progress lifecycle, question settle/recover,
   rich rendering (Teams cost 3.4k lines as the cheapest channel). Provider
   identity has ≥4 shadow copies because config/ can't import channels/. Fix:
   channel-neutral engine owning state machines, channels = primitive port;
   entry stages small (provider descriptor to domain/, unify splitting).
3. **Executable agent-lane contract (stage→cycle).** Frame protocol = 3
   hand-synced copies; recovery semantics = regexes over English error prose
   (failover-eligibility.ts:60-100, ~18 sites); signed permission IPC client
   duplicated (334 vs 336 lines); 9 inline tools re-declared beside the MCP
   table; 2×2 lane matrix = four loops. Fix staged: shared frame module +
   typed errorCode (small); one permission client (small); one tool table
   (stage); inline lane hosts the runner in-process (cycle).
4. **Settings: ~7 representations per setting (stage).** This branch measured
   it: observability block = parser+3×defaults+2×case-maps+allowlist across
   10 files; canonicalization = render-then-reparse; additive keys force
   reader-version bumps that freeze fleet convergence mid-upgrade
   (settings-revision-listener.ts:151). Fix: zod schema per block (z.infer +
   .default() + one case transform), tolerant reader carrying unknown blocks;
   adopt block-by-block.
5. **Brain = copy-pasted second memory engine (stage).** brain-recall.ts
   clones memory RRF (same constants); two dream pipelines, ~17 tables;
   memory bypasses typed repos (deps `any`, 43 sites) while brain shows the
   correct shape; unbounded recall-event ledgers. Fix: one engine
   parameterized by item kind; typed memory repository.
6. **Composition assumes one process = one app (stage; BLOCKS planned
   tenant-isolation + in-process E2E).** getRuntimeStorage() singleton at 139
   sites/53 files; AppMemoryService.getInstance(); DEFAULT_MEMORY_APP_ID
   baked in; setter-based two-phase init (group-queue nullable fn). Fix:
   mechanical injection at bootstrap; construct services with (db, appId);
   guard test freezing the singleton count.
7. **Host IPC task contract untyped (stage).** TaskIpcData = type:string +
   ~60 optional fields across ~44 task types; security lease/route check
   copy-pasted ×3 (runtime/ipc-parsing.ts); six copy-pasted dispatch lanes;
   memory has a parallel 1.3k-line IPC stack; admin handlers parked in
   jobs/. Fix: discriminated-union zod schemas + typed handler map + one
   generic lane processor.
8. **Operability floor (small, do soon).** No retention on runtime_events/
   job_runs/memory ledgers; 526 catch blocks with zero error counters despite
   a Prometheus registry; logger.child() unused (no runId/appId correlation —
   OTel spans won't correlate with logs); double redaction per log line. Fix:
   retention system job, counter helper at ~15 swallow sites, per-turn child
   logger with {runId, appId, traceId}.

Honorable mentions: de facto domain layer lives in shared/ (policy/catalog
clusters belong in domain/); domain/types.ts 603-line bucket (206 importers);
raw SQL outside storage adapter (24 sites); scheduler O(workers×jobs)/60s
full-sync; verification gate red-by-default; hand-maintained Postgres test
list. 193-entry architecture-exception ledger (162 tagged to an unowned
cleanup phase) caps growth but nothing burns it down.

Suggested sequencing by payoff-per-cost: 8 → 3a/3b → 4 → 6 → 7 → 5 → 2 → 1
(1's small reliability fixes — durable send_message, IPC backpressure —
shippable immediately).

## Queueing decision (user-approved 2026-07-17)

- NEAR-TERM (after current C+D/audit/permission cycles, before other arch
  work): finding 8 (retention job, error counters, per-turn child logger) +
  finding 1's quick fixes (durable send_message via outbound queue; IPC
  overload defer-not-archive + per-folder cap). Days-class, protects
  everything else.
- Finding 6 (composition/appId injection) executes BEFORE the planned
  tenant-isolation hardening — it is its prerequisite.
- Remaining cycles as validated goal-prompts in review order:
  3a/3b → 4 → 7 → 5 → 2 → 1(full). Each through the Codex validation gate.
