BLOCKING findings

1. `hardFloor` is not safely excluded by the specified edit. The current relaxation predicate does not check `hardFloor !== true`; an ASK carrying both `hardFloor` and an otherwise-relaxable signal could gain `railProvenance` and reach the classifier-Allow branch (`apps/core/src/runtime/ipc-permission-classifier-decision.ts:409-431`, `:530-542`). AC2 merely says “extend” that predicate and requests a generic hard-floor test (`askfloor-1-t4-taskplan.md:20`).
   Concrete plan fix: require an explicit `railAsk.hardFloor !== true` guard. Name leaves combining `hardFloor: true` with each typed signal and both live/cached classifier Allows; assert no `auto_classifier` authorization and the existing card path.

2. AC2 gives contradictory instructions for the meta-executor leaf. It requires jobs to support both overridable signals with `railProvenance`, but also says the `:338-371` job meta-executor veto is “retained” (`askfloor-1-t4-taskplan.md:20`). That leaf explicitly says the veto remains in job lanes and supplies `hostJobId: 'job-find'` (`apps/core/test/unit/runtime/ipc-permission-classifier-decision.test.ts:338-370`).
   Concrete plan fix: distinguish the authoritative first-ask-floor case from the later classifier-eligible case. Retitle/update the existing leaf for the former, and name a separate job leaf proving a classifier Allow for eligible read-only meta-execution produces `auto_classifier` plus `railProvenance`.

3. AC3 does not name the required replacement for its enclosing stale leaf title. It says to rewrite only `:1160-1186`, while the leaf title still promises that a scheduled run “keep[s] today’s consult” (`apps/core/test/unit/bootstrap/inline-agent-loop-tools.test.ts:1086`); its scheduled row currently expects one classifier call (`:1160-1184`).
   Concrete plan fix: explicitly split or retitle the leaf: one scheduled-owner projection-hit leaf asserting zero classifier calls plus audit, and one blank-owner leaf asserting zero repository calls and classifier fallthrough.

NON-BLOCKING notes

1. The other AC2 seam cites are accurate: cache bypass `:183-187`, trusted-host eligibility `:339-343`, shared consultation `:361-397`, native cache-write exclusions `:504-518`, route guard `:275-302`, Allow `:530-542`, and job ASK fallthrough/card `:544-622`.

2. Trust ownership is correct: `hostJobId` comes from the host run restriction (`ipc-permission-classifier-decision.ts:91-98`); worker `request.jobId` remains explicitly non-authoritative classifier metadata (`:368-370`).

3. The `allow | ask` fold matches both implementations: only Allow is authorization (`ipc-permission-classifier-decision.ts:530-542`; `inline-agent-loop-tools.ts:443-448`), while non-Allow continues to existing job handling (`:450-460`, IPC `:565-622`).

4. AC3’s ordering cite `:390-398` and AC7’s architecture range `permission-decision-memory.md:26-32` are correct. The earlier AC3 shorthand `inline-agent-loop-tools.ts:395` should be corrected to `:390-398`; line 395 is only the `reviewedRuleDecision` property.

NOT CLEAN
