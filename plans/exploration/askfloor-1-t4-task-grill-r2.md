## BLOCKING findings

1. **The projected Allow bypasses the IPC route/risk guard.** V2 places projection beside the remembered-Allow return and claims the untouched guard still runs (`askfloor-1-t4-taskplan.md:7,17`). At that position the coordinator returns before `tail` (`apps/core/src/runtime/permission-decision-coordinator.ts:227-243`), while `applyIpcPermissionRouteGuard` exists only inside the tail and owns both missing-route denial and worker-risk sanitization (`apps/core/src/runtime/ipc-permission-classifier-decision.ts:261-301`).
   **Plan fix:** add a typed pre-projection IPC guard callback receiving the rail decision; invoke it immediately before projection lookup and delegate to the route/risk guard. Add a projected-match + absent-route denial test.

2. **The projection facts are not the same facts T3b uses.** V2 specifies `effectHash`, `canonicalRoot`, and a singular `kindVariant` (`askfloor-1-t4-taskplan.md:10,16`). T3b also passes `workspaceRoot`, required to derive path-only exact native-write keys (`apps/core/src/runtime/permission-human-memory-stage.ts:104-120`; `apps/core/src/application/permissions/human-decision-scope.ts:82-88,97-113`). T3b has no `kindVariant`; it derives both tool-kind and category-kind candidates (`permission-human-memory-stage.ts:52-73`). As written, exact file-write keys can differ and the five-candidate order is ambiguous.
   **Plan fix:** define facts as `{effectHash, workspaceRoot, canonicalRoot?}`; remove `kindVariant`; derive exact, tool-kind, category-kind, tool-place, category-place using `trustGrowthTool: true/false` exactly as T3b does.

3. **The helper contract is still internally inconsistent.** AC1 names nonexistent `PermissionDecisionMemoryPort`, while the live domain contract is `PermissionDecisionMemoryRepository` (`apps/core/src/domain/ports/permission-decision-memory.ts:149-195`). Ruling 4/AC1 say the application helper returns a completed `decision`, but also say the coordinator builds it; the Technical Approach repeats coordinator ownership (`askfloor-1-t4-taskplan.md:10,16,25`). The helper requires injected `warn`, but the declared coordinator input contains only owner and memory (`askfloor-1-t4-taskplan.md:16-17`).
   **Plan fix:** use `PermissionDecisionMemoryRepository`; have the helper return a typed match `{recordId, scope}` only; have the coordinator build/stamp the decision; add `warn` to the typed projection input and specify both lane suppliers.

4. **The 20-file “exact” write/proof set is incomplete.** The architecture contract still says autonomous lanes never consult human-decision memory (`docs/architecture/permission-decision-memory.md:26-32`), but that document is absent from the write list (`askfloor-1-t4-taskplan.md:37`). Inline tests inject dependencies directly through `wireInlineAgentLoopTools` (`apps/core/test/unit/bootstrap/inline-agent-loop-tools.test.ts:65-120`), so they cannot prove that the production `runtime-services.ts` call supplies the repository-backed audit closure (`apps/core/src/app/bootstrap/runtime-services.ts:331-345`). This repeats the production-forwarding proof gap that V2 correctly closed for IPC.
   **Plan fix:** add the architecture document and `test/unit/bootstrap/runtime-services.test.ts`; update the architecture text and add a production inline-audit wiring leaf. Recount the exact scope as 22 files; the 24-file budget still fits.

## NON-BLOCKING notes

- `deps.opsRepository.getJobById(hostJobId)` is reachable and correctly typed (`apps/core/src/runtime/ipc-domain-types.ts:108`; `apps/core/src/domain/repositories/ops-repo.ts:221-224`).
- Optional `AgentInput.jobOwnerPersonId` does not require a contracts or fixed-image schema edit: runner input structurally spreads `AgentInput` (`apps/core/src/runtime/agent-spawn-input-projection.ts:53-62`).
- The typed decision carrier is feasible line-neutrally, and automatic IPC decisions do reach the existing post-apply audit call (`apps/core/src/domain/types.ts:300-314`; `apps/core/src/runtime/ipc-interaction-processing.ts:221-243,327-343`).
- The ≤5-line inline seam is feasible through the existing spread at `inline-agent-loop-tools.ts:397`, scheduled classifier exclusion at `:412`, and one audit-helper call before `:567`.
- Ceiling pressure is real: `domain/types.ts` is 740/740, `inline-agent-loop-tools.ts` 749/750, `execution-phases-run.ts` 700/700, and `runtime-services.ts` 1184/1186.

NOT CLEAN
