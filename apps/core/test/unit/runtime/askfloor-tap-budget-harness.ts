import fs from 'node:fs';

import type { PermissionApprovalDecision } from '@core/domain/types.js';
import type { PermissionDecisionSource } from '@core/domain/types.js';
import type { RailProvenance } from '@core/domain/permission-lane.js';
import type { PermissionMode } from '@core/shared/permission-mode.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { unregisterPermissionRunRestriction } from '@core/runtime/permission-decision-coordinator.js';
import { permissionDecisionResult } from '../channels/permission-approval-result-helpers.js';

export interface TapBudgetFixture {
  permissionMode: PermissionMode;
  hostJobId?: string;
  workspaceRoot: string;
  command?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  attachmentOpenIds?: { wellFormed: boolean; count: number };
  trustedRoots: string[];
  classifierVerdict: {
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    risk_category?:
      | 'destructive'
      | 'privileged'
      | 'secret'
      | 'network'
      | 'filesystem'
      | 'benign';
    reason: string;
  };
  classifierConsult?: () => Promise<
    TapBudgetFixture['classifierVerdict'] & { latencyMs: number }
  >;
}

export async function assertLlmConsultNotInvoked(): Promise<never> {
  throw new Error('Expected the LLM classifier consult not to be invoked.');
}

export async function replayPermissionRequest(
  fixture: TapBudgetFixture,
): Promise<{
  taps: number;
  decidedBy: PermissionApprovalDecision['decidedBy'];
  source: PermissionDecisionSource;
  railProvenance: RailProvenance | null;
}> {
  fs.mkdirSync(fixture.workspaceRoot, { recursive: true });
  let taps = 0;
  const responseKeyId = fixture.hostJobId
    ? `tap-budget-${fixture.hostJobId}`
    : undefined;
  if (responseKeyId) {
    registerWorkerPermissionRunRestriction({
      sourceAgentFolder: 'main_agent',
      responseKeyId,
      hideAuthorityTools: false,
      runKind: 'scheduled',
      jobId: fixture.hostJobId!,
      runId: `run-${fixture.hostJobId}`,
    });
  }
  let decision: PermissionApprovalDecision;
  try {
    decision = await resolvePermissionIpcDecision({
      request: {
        requestId: `tap-budget-${fixture.command ?? fixture.toolName}`,
        ...(responseKeyId
          ? { responseKeyId, targetJid: 'tap-budget:conversation' }
          : {}),
        sourceAgentFolder: 'main_agent',
        toolName: fixture.toolName ?? 'RunCommand',
        toolInput: fixture.toolInput ?? { command: fixture.command },
        ...(fixture.attachmentOpenIds
          ? { attachmentOpenIds: fixture.attachmentOpenIds }
          : {}),
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () =>
          responseKeyId
            ? ({
                'tap-budget:conversation': {
                  name: 'tap budget',
                  folder: 'main_agent',
                  trigger: '@gantry',
                  added_at: '2026-09-04',
                  agentConfig: { permissionMode: fixture.permissionMode },
                },
              } as never)
            : {},
        requestPermissionApproval: async () => {
          taps += 1;
          return permissionDecisionResult({
            approved: false,
            mode: 'cancel',
            decidedBy: 'owner',
            source: 'user',
          });
        },
        classifierConsult:
          fixture.classifierConsult ??
          (async () => ({
            ...fixture.classifierVerdict,
            latencyMs: 1,
          })),
        publishRuntimeEvent: async () => undefined,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: { permissionMode: fixture.permissionMode },
          },
          permissions: {
            autoMode: {},
            trustedRoots: fixture.trustedRoots,
          },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });
  } finally {
    if (responseKeyId) {
      unregisterPermissionRunRestriction({
        sourceAgentFolder: 'main_agent',
        responseKeyId,
      });
    }
  }
  if (!decision.source) {
    throw new Error('Replay decision is missing canonical provenance.');
  }
  return {
    taps,
    decidedBy: decision.decidedBy,
    source: decision.source,
    railProvenance: decision.railProvenance ?? null,
  };
}

export const TAP_BUDGET_WORKSPACE_ROOT =
  resolveWorkspaceFolderPath('main_agent');
