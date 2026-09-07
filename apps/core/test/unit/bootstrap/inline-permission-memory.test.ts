import { describe, expect, it, vi } from 'vitest';

import { inlinePermissionMemoryInputs } from '@core/app/bootstrap/inline-permission-memory.js';
import { computePermissionEffectHash } from '@core/domain/permission-effect-key.js';
import { PermissionLane } from '@core/domain/permission-lane.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';

describe('inline permission memory', () => {
  it('derives the inline consult inputs through the shared lane derivation: interactive_auto with the run person and the effect hash for a non-scheduled auto run, an autonomous lane without a person for a scheduled run, and no memory port when the host does not provide one', () => {
    const request: PermissionApprovalRequest = {
      requestId: 'inline-memory',
      sourceAgentFolder: 'main_agent',
      appId: 'default',
      toolName: 'mcp__crm__read',
      toolInput: { id: 'crm-1' },
    };
    const workspaceRoot = resolveWorkspaceFolderPath('main_agent');
    const decisionMemory = {} as never;
    const deps = {
      getPermissionDecisionMemoryRepository: vi.fn(() => decisionMemory),
    };
    const laneInput = { group: { folder: 'main_agent' } } as never;
    const interactive = inlinePermissionMemoryInputs({
      run: {
        permissionMode: 'auto',
        memoryUserId: 'person-one',
      } as never,
      laneInput,
      request,
      deps,
    });

    expect(interactive).toEqual({
      analysis: {
        lane: PermissionLane.InteractiveAuto,
        readOnlyMetaExecutor: false,
      },
      effectHash: computePermissionEffectHash({ request, workspaceRoot }),
      workspaceRoot,
      decisionMemory,
      personId: 'person-one',
    });

    expect(
      inlinePermissionMemoryInputs({
        run: {
          permissionMode: 'auto',
          memoryUserId: 'person-one',
          isScheduledJob: true,
        } as never,
        laneInput,
        request,
        deps,
      }),
    ).toMatchObject({
      analysis: {
        lane: PermissionLane.Autonomous,
        readOnlyMetaExecutor: false,
      },
      decisionMemory,
    });
    expect(
      inlinePermissionMemoryInputs({
        run: {
          permissionMode: 'auto',
          memoryUserId: 'person-one',
          isScheduledJob: true,
        } as never,
        laneInput,
        request,
        deps,
      }),
    ).not.toHaveProperty('personId');

    expect(
      inlinePermissionMemoryInputs({
        run: { permissionMode: 'ask' } as never,
        laneInput,
        request,
        deps: {},
      }),
    ).toMatchObject({
      analysis: { lane: PermissionLane.Ask },
      workspaceRoot,
    });
    expect(
      inlinePermissionMemoryInputs({
        run: { permissionMode: 'auto_strict' } as never,
        laneInput,
        request,
        deps: {},
      }).analysis.lane,
    ).toBe(PermissionLane.AutoStrict);
    expect(
      inlinePermissionMemoryInputs({
        run: { permissionMode: 'ask' } as never,
        laneInput,
        request,
        deps: {},
      }),
    ).not.toHaveProperty('decisionMemory');
  });
});
