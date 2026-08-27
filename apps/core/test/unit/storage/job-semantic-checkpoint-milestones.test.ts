import { describe, expect, it } from 'vitest';
import {
  assertMilestoneArtifacts,
  InvalidJobSemanticCheckpointError,
} from '../../../src/adapters/storage/postgres/repositories/job-semantic-checkpoint-repository.postgres.js';

const reference = (kind: string) => ({
  artifactId: `file-artifact:${kind}`,
  contentHash: `sha256:${'a'.repeat(64)}`,
  kind,
});

const payload = (kinds: string[]) => ({
  safePhase: 'test',
  artifactRefs: kinds.map(reference),
  nextAction: 'Continue.',
  cumulativeRuntimeMs: 1,
});

describe('website recipe semantic checkpoint artifact gates', () => {
  it('requires an observation inventory before inventory completion', () => {
    expect(() =>
      assertMilestoneArtifacts('inventory_completed', payload([])),
    ).toThrow(InvalidJobSemanticCheckpointError);
    expect(() =>
      assertMilestoneArtifacts(
        'inventory_completed',
        payload(['observation_inventory']),
      ),
    ).not.toThrow();
  });

  it('requires the retained inventory, candidate, and test plan before evaluation', () => {
    expect(() =>
      assertMilestoneArtifacts('test_plan_created', payload(['test_plan'])),
    ).toThrow(/observation_inventory, recipe_candidate/u);
    expect(() =>
      assertMilestoneArtifacts(
        'test_plan_created',
        payload(['observation_inventory', 'recipe_candidate', 'test_plan']),
      ),
    ).not.toThrow();
  });
});
