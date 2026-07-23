import { describe, expect, it, vi } from 'vitest';

import type { PermissionApprovalRequest } from '@core/domain/types.js';
import type { ToolPolicyDecision } from '@core/shared/tool-execution-policy-service.js';
import { buildSdkFilesystemSandbox } from '@core/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.js';
import {
  coordinatePermissionDecision,
  permissionRunRestriction,
  unregisterPermissionRunRestriction,
} from '@core/runtime/permission-decision-coordinator.js';
import * as permissionCoordinator from '@core/runtime/permission-decision-coordinator.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';

const GATES = [
  'SDK worker',
  'DeepAgents shell',
  'DeepAgents third-party MCP',
  'DeepAgents facade',
  'inline core tool',
  'inline third-party MCP',
] as const;

const request: PermissionApprovalRequest = {
  requestId: 'permission-test',
  sourceAgentFolder: 'main_agent',
  toolName: 'FileRead',
  toolInput: { path: 'README.md' },
};

const reviewedAllow: ToolPolicyDecision = {
  status: 'allow',
  reason: 'Allowed by reviewed rule FileRead.',
  audit: {
    category: 'tool_execution',
    origin: 'host',
    toolKind: 'file',
    toolName: 'FileRead',
    mutationIntent: 'read',
  },
};

describe('coordinatePermissionDecision', () => {
  it.each(
    GATES.flatMap((gate) => [
      {
        gate,
        authority: 'hard-deny',
        input: {
          hardDenyReason: 'hard denied',
          accessPreset: 'locked' as const,
          fixedImageRestricted: true,
          reviewedRuleDecision: reviewedAllow,
        },
        expected: { approved: false, decidedBy: 'hard_deny' },
      },
      {
        gate,
        authority: 'locked-preset',
        input: {
          accessPreset: 'locked' as const,
          fixedImageRestricted: true,
          reviewedRuleDecision: reviewedAllow,
        },
        expected: { approved: false, decidedBy: 'locked_preset' },
      },
      {
        gate,
        authority: 'fixed-image',
        input: {
          fixedImageRestricted: true,
          reviewedRuleDecision: reviewedAllow,
        },
        expected: { approved: false, decidedBy: 'fixed_image' },
      },
      {
        gate,
        authority: 'reviewed-rule-allow',
        input: { reviewedRuleDecision: reviewedAllow },
        expected: { approved: true, decidedBy: 'reviewed_rule' },
      },
    ]),
  )('$gate: $authority beats the otherwise-allowing tail', async (testCase) => {
    const tail = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once' as const,
      decidedBy: 'tail',
    }));
    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        ...testCase.input,
        tail,
      }),
    ).resolves.toMatchObject(testCase.expected);
    expect(tail).not.toHaveBeenCalled();
  });

  it('uses the injected deterministic rails before the classifier/human tail', async () => {
    const tail = vi.fn();
    const deterministicRails = vi.fn(() => ({
      approved: false,
      mode: 'cancel' as const,
      reason: 'rail asks',
    }));
    await expect(
      coordinatePermissionDecision({
        request,
        deterministicRails,
        tail,
      }),
    ).resolves.toMatchObject({ approved: false, reason: 'rail asks' });
    expect(deterministicRails).toHaveBeenCalledOnce();
    expect(tail).not.toHaveBeenCalled();
  });

  it('registers the default rails before the classifier/human tail', async () => {
    const tail = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: {
          ...request,
          toolName: 'RunCommand',
          toolInput: { command: 'rm -rf ./build' },
        },
        tail,
      }),
    ).resolves.toMatchObject({
      approved: false,
      decidedBy: 'deterministic_rails',
    });
    expect(tail).not.toHaveBeenCalled();
  });

  it('keeps credential reads at the rails ask floor with the direct SDK escape hatch disabled', async () => {
    const sdkSandbox = buildSdkFilesystemSandbox(['~/.ssh']);
    const tail = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once' as const,
      decidedBy: 'tail',
    }));

    expect(sdkSandbox.allowUnsandboxedCommands).toBe(false);
    expect(sdkSandbox.filesystem?.denyRead).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/\.ssh$/)]),
    );
    await expect(
      coordinatePermissionDecision({
        request: {
          ...request,
          toolName: 'RunCommand',
          toolInput: { command: 'cat ~/.ssh/id_rsa' },
        },
        tail,
      }),
    ).resolves.toMatchObject({
      approved: false,
      decidedBy: 'deterministic_rails',
      reason: expect.stringContaining('credential'),
    });
    expect(tail).not.toHaveBeenCalled();
  });

  it.each([
    [
      'allow',
      {
        approved: true,
        mode: 'allow_once' as const,
        decidedBy: 'classifier_cache',
      },
    ],
    [
      'deny',
      {
        approved: false,
        mode: 'cancel' as const,
        decidedBy: 'classifier_cache',
      },
    ],
  ])(
    're-validates a cached %s against current rails',
    async (_label, cachedDecision) => {
      const tail = vi.fn(async () => cachedDecision);
      const shellRequest = {
        ...request,
        toolName: 'RunCommand',
        toolInput: { command: 'git status' },
      };

      await expect(
        coordinatePermissionDecision({
          request: { ...shellRequest },
          deterministicRailsInput: {
            workspaceRoot: '/workspace',
            trustedRoots: ['/workspace'],
          },
          tail,
        }),
      ).resolves.toEqual(cachedDecision);

      await expect(
        coordinatePermissionDecision({
          request: { ...shellRequest },
          deterministicRailsInput: {
            workspaceRoot: '/workspace',
            trustedRoots: [],
          },
          tail,
        }),
      ).resolves.toMatchObject({
        approved: false,
        decidedBy: 'deterministic_rails',
        reason: expect.stringContaining('outside'),
      });
      expect(tail).toHaveBeenCalledTimes(1);
    },
  );

  it('spawn registration stores and removes the host restriction by agent/run key', () => {
    const key = {
      sourceAgentFolder: 'main_agent',
      responseKeyId: 'response-key-run-1',
    };
    registerWorkerPermissionRunRestriction({
      ...key,
      hideAuthorityTools: true,
    });
    expect(permissionRunRestriction(key)).toEqual({
      hideAuthorityTools: true,
    });
    unregisterPermissionRunRestriction(key);
    expect(permissionRunRestriction(key)).toBeUndefined();
  });

  it('reaches the coordinator exactly once for an SDK worker IPC decision', async () => {
    const coordinate = vi.spyOn(
      permissionCoordinator,
      'coordinatePermissionDecision',
    );
    await resolvePermissionIpcDecision({
      request: {
        requestId: 'sdk-worker-once',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'echo hello' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({}),
        requestPermissionApproval: vi.fn(async () => ({
          approved: false,
          mode: 'cancel' as const,
        })),
        getPermissionRuntimeSettings: () => ({
          agents: { main_agent: { permissionMode: 'ask' as const } },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });
    expect(coordinate).toHaveBeenCalledTimes(1);
    coordinate.mockRestore();
  });

  it('consults the host registry before the IPC tail', async () => {
    const key = {
      sourceAgentFolder: 'main_agent',
      responseKeyId: 'fixed-image-run',
    };
    registerWorkerPermissionRunRestriction({
      ...key,
      hideAuthorityTools: true,
    });
    const requestPermissionApproval = vi.fn();
    await expect(
      resolvePermissionIpcDecision({
        request: {
          requestId: 'fixed-image-request',
          responseKeyId: key.responseKeyId,
          sourceAgentFolder: key.sourceAgentFolder,
          toolName: 'FileRead',
          toolInput: { path: 'README.md' },
        },
        sourceAgentFolder: key.sourceAgentFolder,
        deps: {
          conversationRoutes: () => ({}),
          requestPermissionApproval,
          getPermissionRuntimeSettings: () => ({
            agents: {},
            permissions: { autoMode: {} },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      }),
    ).resolves.toMatchObject({
      approved: false,
      decidedBy: 'fixed_image',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    unregisterPermissionRunRestriction(key);
  });
});
