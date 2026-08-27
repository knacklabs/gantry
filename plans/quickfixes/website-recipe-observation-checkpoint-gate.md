# Website recipe observation checkpoint gate

Status: completed

The approved Manipal recipe-completeness plan requires Gantry checkpoints to
prove that the agent retained immutable observation, candidate, and test-plan
artifacts before evaluator submission.

- `inventory_completed` requires `observation_inventory`.
- `candidate_created` and `candidate_repaired` require `recipe_candidate`.
- `test_plan_created` requires all three of `observation_inventory`,
  `recipe_candidate`, and `test_plan`.
- Existing job scope and content-hash verification remains authoritative.

Verify with the semantic-checkpoint unit/integration tests and core typecheck.

Verified with the full core typecheck and 15 focused checkpoint/evaluator
submission tests. Evaluation submission also rejects observation evidence
references that are absent from the retained test-plan checkpoint.
