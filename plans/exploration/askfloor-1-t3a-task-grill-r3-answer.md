# ASKFLOOR-1-T3a task-contract grill — round 3 answer (gpt-5.6-sol @ xhigh)

1. **Legacy repository methods become person-unsafe for `human_decision`.** Only generic `put` was restricted; `get`, `list`, `revoke` accept the new kind without `actingPersonId`, and `revoke` can affect multiple people sharing a scope key. Minimal fix: type and runtime-restrict legacy `put/get/list/revoke` to non-human kinds, ensure an unfiltered legacy `list` excludes human rows, and test every refusal.
2. **The canonical-tool formula has the wrong return type.** `gantryNativeCanonicalToolName` returns `{ canonical, known } | null`, not a string. Minimal fix: `gantryNativeCanonicalToolName(request.toolName)?.canonical ?? request.toolName`.
3. **Native canonical destinations cannot be produced within the declared architecture.** AC3 requires `path.resolve` inside the application module, but application permits no external imports, and the shared boundary does not expose its resolved path. Minimal fix: extend the shared boundary's success result with `canonicalPath`, add that helper and its test to the write scope, consume the returned path.
4. **The stated `stdinOk` rule does not match the shipped T2a gate.** The gate passes `true` to every leaf of every multi-leaf compound, not only pipelines; the parser exposes only aggregate topology. Minimal fix: mirror the gate exactly and pin compound/pipeline parity.
5. **Dual native destinations can bypass the protected-destination prohibition.** Minimal fix: every supplied native destination is boundary-checked first; any refusal yields `protected_destination`; only an all-safe dual input falls back to the full hash; add a conflicting-dual test.
6. **The named leaves do not close every declared API behavior.** `includeRevoked` semantics and short-id disambiguation before `limit` are undefined/untested. Minimal fix: define both and name the assertions in the leaves.

Non-blocking: ACs, contracts and saved-plan criteria byte-identical; eight leaves, three Postgres; the v3 fold present; the plan's "source, 8" label vs nine listed sources; the generate command should carry `-- --name permission_decision_memory_human`.

NOT CONVERGED — six contract blockers remain.

## Fold (orchestrator, contract v4)

All six folded plus the two notes: (1) legacy `put/get/list/revoke` refuse the human kind via `HumanDecisionRequiresTypedAccessError`, unfiltered legacy `list` excludes human rows; (2) `?.canonical`; (3) the shared boundary's success result becomes `{ inside: true, canonicalPath }` — `shared/permission-prospective-write.ts` and its unit suite join the write scope (16 files, budget 18 / 22,000); (4) `stdinOk` mirrors the gate exactly (single leaf false, every leaf of any compound true) with a parity test; (5) every native destination boundary-checked first, any refusal ⇒ `protected_destination`, all-safe dual ⇒ full hash, conflicting-dual test; (6) `includeRevoked` default false / true adds revoked rows with `revokedAt`, short ids disambiguated against all active siblings before `limit`; "source, 10" and the `--name` flag.
