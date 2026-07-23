# Deferral Ledger

Deliberately-removed scope with explicit revisit triggers (`forge defer add`).
When a trigger fires, the item goes back on the roadmap and its row is
resolved: `./forge defer resolve <id> --notes "<what happened>"`.

| id | added | item | why deferred | trigger to revisit | status |
|----|-------|------|--------------|--------------------|--------|
| D-0001 | 2026-07-22 | Data retention for jobs/interactions/runtime events (split out of arch-quick-wins as cycle-sized) | Entangled with scheduler/lease/agent machinery; the promised ledger note never landed anywhere trackable | durable-work-primitive lane starts (it refactors the same jobs/interactions state) | open |
| D-0002 | 2026-07-22 | E2E persona/topology harness goal-prompt (re-draft) | goals-index referenced a scratchpad draft that did not survive; scope needs re-drafting from scratch | agent-e2e test-matrix reconciliation pass | open |
| D-0003 | 2026-07-22 | Split apps/core/src/application/mcp/mcp-tool-proxy.ts (ratcheted at 800 in architecture-map.json lineBudgets) | File is the capability-authoring lane's conflict window; splitting on main would collide with branch feature/capability-authoring @13ae2e698 | CAP-1 capability-authoring closeout merges | open |
| D-0004 | 2026-07-22 | Retire the provider_specific_path exception on apps/core/src/shared/sdk-native-skill-names.ts (4 anthropic matches, sentinel contract) | anthropic_sdk is a deliberate sentinel token per decision 0028; relocation breaks layer rules, so an exact-count exception is the sanctioned cap | any change to the agent-harness selection vocabulary superseding decision 0028 | open |
