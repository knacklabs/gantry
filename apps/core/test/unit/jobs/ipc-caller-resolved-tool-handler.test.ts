import { describe, expect, it } from 'vitest';

import {
  approvedRecipeOriginHost,
  callerResolvedToolUsesInteractionBudget,
  recipeHumanWaitCheckpointReady,
  resolveCallerResolvedRunId,
} from '@core/jobs/ipc-caller-resolved-tool-handler.js';

describe('caller-resolved tool run correlation', () => {
  it('uses total runtime instead of a fixed count for typed recipe waits', () => {
    expect(callerResolvedToolUsesInteractionBudget('ask_user', undefined)).toBe(true);
    expect(
      callerResolvedToolUsesInteractionBudget(
        'website_recipe_request_human',
        'default',
      ),
    ).toBe(true);
    expect(
      callerResolvedToolUsesInteractionBudget(
        'website_recipe_request_human',
        'recipe_authoring',
      ),
    ).toBe(false);
  });

  it('requires the mandatory human-wait checkpoint before assistance', () => {
    expect(recipeHumanWaitCheckpointReady('human_wait')).toBe(true);
    expect(recipeHumanWaitCheckpointReady('candidate_created')).toBe(false);
    expect(recipeHumanWaitCheckpointReady(undefined)).toBe(false);
  });

  it('uses the signed request run id when present', () => {
    expect(
      resolveCallerResolvedRunId({
        runId: 'run-direct',
        parentTaskId: 'task-child',
        sandboxRunId: 'run-policy',
      }),
    ).toBe('run-direct');
  });

  it('inherits the host policy run only for a delegated child', () => {
    expect(
      resolveCallerResolvedRunId({
        parentTaskId: 'task-child',
        sandboxRunId: 'run-policy',
      }),
    ).toBe('run-policy');
    expect(
      resolveCallerResolvedRunId({ sandboxRunId: 'run-policy' }),
    ).toBeUndefined();
  });

  it('falls back to the durable parent task run only for a delegated child', () => {
    expect(
      resolveCallerResolvedRunId({
        parentTaskId: 'task-child',
        parentTaskRunId: 'run-parent',
      }),
    ).toBe('run-parent');
    expect(
      resolveCallerResolvedRunId({ parentTaskRunId: 'run-parent' }),
    ).toBeUndefined();
  });
});

describe('approvedRecipeOriginHost', () => {
  const request = {
    type: 'origin',
    permissionScope: {
      origin: 'https://documents.example.gov',
      methods: ['GET', 'HEAD'],
    },
  };

  it('returns the exact public host for a matching bounded approval', () => {
    expect(
      approvedRecipeOriginHost({
        request,
        resolution: {
          approved: true,
          permissionScope: {
            origin: 'https://documents.example.gov',
            methods: ['GET'],
          },
        },
      }),
    ).toBe('documents.example.gov');
  });

  it('rejects broader or different approvals', () => {
    expect(() =>
      approvedRecipeOriginHost({
        request,
        resolution: {
          approved: true,
          permissionScope: {
            origin: 'https://other.example.gov',
            methods: ['POST'],
          },
        },
      }),
    ).toThrow('match the requested exact origin');
  });
});
