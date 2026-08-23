import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { appendSetupPauseRequirementAfterPersistentGrant } from '@core/app/bootstrap/setup-pause-permission-wiring.js';
import { truthfulAutonomousDenialDetail } from '@core/adapters/llm/anthropic-claude-agent/runner/autonomous-permission-recovery.js';
import { decisionForMode } from '@core/domain/permission-decision.js';
import {
  createIpcResponseSigningKeyPair,
  signIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { requestPermissionApprovalViaIpc } from '@core/runner/permission-ipc-client.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { unregisterPermissionRunRestriction } from '@core/runtime/permission-decision-coordinator.js';
import { ipcInteractionAuthValidationOptions } from '@core/shared/ipc-interaction-lifetime.js';
import { getPermissionTimeoutMs } from '@core/shared/permission-timeout.js';
import {
  buildAgentToolExecutionRequest,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '@core/shared/tool-execution-policy-service.js';

const PERSISTENT_RUN_COMMAND_UPDATE = {
  type: 'addRules' as const,
  behavior: 'allow' as const,
  destination: 'session' as const,
  rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
};

function permissionRoute() {
  return {
    'tg:job': {
      folder: 'main_agent',
      agentConfig: { permissionMode: 'auto' as const },
      conversationKind: 'channel' as const,
    },
  };
}

async function waitForRequestFile(directory: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [file] = fs.existsSync(directory)
      ? fs.readdirSync(directory).filter((entry) => entry.endsWith('.json'))
      : [];
    if (file) return file;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the permission request file.');
}

it('jobperm-1-t1-card-not-cancel', async () => {
  const responseKeyId = 'jobperm-card-response-key';
  const requestPermissionApproval = vi.fn(async (request) => ({
    kind: 'decision' as const,
    decision: decisionForMode(
      request,
      'allow_persistent_rule',
      'operator-1',
      'human',
    ),
  }));
  const classifierConsult = vi.fn();
  registerWorkerPermissionRunRestriction({
    sourceAgentFolder: 'main_agent',
    responseKeyId,
    hideAuthorityTools: false,
    runKind: 'scheduled',
    jobId: 'job-1',
    runId: 'run-1',
  });
  try {
    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'jobperm-grantable-miss',
        responseKeyId,
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:job',
        jobId: 'job-1',
        unattended: true,
        toolName: 'RunCommand',
        toolInput: { command: 'npm test unit' },
        suggestions: [PERSISTENT_RUN_COMMAND_UPDATE],
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: permissionRoute,
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent: vi.fn(async () => undefined),
        getPermissionRuntimeSettings: () => ({
          agents: { main_agent: { permissionMode: 'auto' as const } },
          permissions: { autoMode: {}, trustedRoots: [] },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'operator-1',
    });
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(requestPermissionApproval.mock.calls[0]![0]).toMatchObject({
      jobId: 'job-1',
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      suggestions: [PERSISTENT_RUN_COMMAND_UPDATE],
    });
    expect(classifierConsult).not.toHaveBeenCalled();

    requestPermissionApproval.mockResolvedValueOnce({
      kind: 'decision',
      decision: decisionForMode(
        {
          toolName: 'RunCommand',
          toolInput: { command: 'npm test denied' },
        },
        'cancel',
        'operator-1',
        'human',
      ),
    });
    await expect(
      resolvePermissionIpcDecision({
        request: {
          requestId: 'jobperm-human-deny',
          responseKeyId,
          sourceAgentFolder: 'main_agent',
          targetJid: 'tg:job',
          jobId: 'job-1',
          unattended: true,
          toolName: 'RunCommand',
          toolInput: { command: 'npm test denied' },
          suggestions: [PERSISTENT_RUN_COMMAND_UPDATE],
          decisionOptions: ['allow_persistent_rule', 'cancel'],
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: permissionRoute,
          requestPermissionApproval,
          classifierConsult,
          publishRuntimeEvent: vi.fn(async () => undefined),
          getPermissionRuntimeSettings: () => ({
            agents: { main_agent: { permissionMode: 'auto' as const } },
            permissions: { autoMode: {}, trustedRoots: [] },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      }),
    ).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'operator-1',
    });
    expect(requestPermissionApproval).toHaveBeenCalledTimes(2);
    expect(classifierConsult).not.toHaveBeenCalled();

    const browserResponseKeyId = 'jobperm-browser-response-key';
    registerWorkerPermissionRunRestriction({
      sourceAgentFolder: 'main_agent',
      responseKeyId: browserResponseKeyId,
      hideAuthorityTools: false,
      runKind: 'scheduled',
      jobId: 'job-browser',
      runId: 'run-browser',
    });
    try {
      const browserDecision = await resolvePermissionIpcDecision({
        request: {
          requestId: 'jobperm-browser',
          responseKeyId: browserResponseKeyId,
          sourceAgentFolder: 'main_agent',
          targetJid: 'tg:job',
          jobId: 'job-browser',
          unattended: true,
          toolName: 'mcp__gantry__browser_open',
          toolInput: { url: 'https://example.com' },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: permissionRoute,
          requestPermissionApproval,
          classifierConsult,
          publishRuntimeEvent: vi.fn(async () => undefined),
          getToolRepository: () => ({
            listAgentToolBindings: vi.fn(async () => [
              { status: 'active', toolId: 'tool:browser', personId: null },
            ]),
            getTool: vi.fn(async () => ({
              id: 'tool:browser',
              appId: 'default',
              name: 'Browser',
            })),
          }),
          getPermissionRuntimeSettings: () => ({
            agents: { main_agent: { permissionMode: 'auto' as const } },
            permissions: { autoMode: {}, trustedRoots: [] },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      });

      expect(browserDecision).toMatchObject({
        approved: true,
        decidedBy: 'reviewed_rule',
      });
      expect(requestPermissionApproval).toHaveBeenCalledTimes(2);
      expect(classifierConsult).not.toHaveBeenCalled();
    } finally {
      unregisterPermissionRunRestriction({
        sourceAgentFolder: 'main_agent',
        responseKeyId: browserResponseKeyId,
      });
    }
  } finally {
    unregisterPermissionRunRestriction({
      sourceAgentFolder: 'main_agent',
      responseKeyId,
    });
  }
});

it('jobperm-1-t1-resume-and-persist', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobperm-wait-'));
  const keys = createIpcResponseSigningKeyPair();
  const watch = vi.spyOn(fs, 'watch').mockImplementation(() => {
    throw new Error('watch unavailable');
  });
  try {
    const decision = requestPermissionApprovalViaIpc(
      {
        appId: 'default',
        agentId: 'agent:main_agent',
        chatJid: 'tg:job',
        jobId: 'job-1',
        jobName: 'Test job',
        jobRunId: 'run-1',
        jobRunLeaseToken: 'lease-1',
        jobRunLeaseFencingVersion: '1',
        ipcAuthToken: 'ipc-auth',
        ipcResponseVerifyKey: keys.publicKeyPem,
        ipcResponseKeyId: 'response-key',
        permissionRequestTimeoutMs: 5_000,
        permissionLane: 'autonomous',
        permissionMode: 'ask',
        resolveWorkspaceIpcDir: (folder) => path.join(tempDir, 'ipc', folder),
      },
      {
        agentFolder: 'main_agent',
        toolName: 'RunCommand',
        toolInput: { command: 'npm test unit' },
        suggestions: [PERSISTENT_RUN_COMMAND_UPDATE],
      },
    );
    const requestDirectory = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const requestFile = await waitForRequestFile(requestDirectory);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDirectory, requestFile), 'utf8'),
    ) as {
      requestId: string;
      responseNonce: string;
      expiresAt?: string;
      authPurpose?: string;
      unattended?: boolean;
    };
    expect(request).toMatchObject({
      authPurpose: 'unbounded-interaction',
      unattended: true,
    });
    expect(request.expiresAt).toBeUndefined();

    const responsePayload = {
      requestId: request.requestId,
      responseNonce: request.responseNonce,
      approved: true,
      mode: 'allow_persistent_rule' as const,
      decidedBy: 'operator-1',
      source: 'human_persistent' as const,
      repeatableForFutureRuns: true,
      reason: 'Approved for this and future runs.',
      updatedPermissions: [PERSISTENT_RUN_COMMAND_UPDATE],
      decisionClassification: 'user_permanent' as const,
    };
    const responseDirectory = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-responses',
    );
    fs.mkdirSync(responseDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(responseDirectory, `${request.requestId}.json`),
      JSON.stringify({
        ...responsePayload,
        signature: signIpcResponsePayload(keys.privateKeyPem, responsePayload),
      }),
    );

    await expect(decision).resolves.toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
      decisionClassification: 'user_permanent',
    });
    expect(
      fs.existsSync(path.join(responseDirectory, `${request.requestId}.json`)),
    ).toBe(false);

    const requirements: Array<{
      target: { kind: 'tool_rule'; rule: string };
      reason?: string;
    }> = [];
    const job = {
      id: 'job-1',
      status: 'active',
      updated_at: '2026-08-23T00:00:00.000Z',
      access_requirements: requirements,
    };
    const appendJobAccessRequirement = vi.fn(async ({ requirement }) => {
      requirements.push(requirement as (typeof requirements)[number]);
      job.updated_at = '2026-08-23T00:00:01.000Z';
      return true;
    });
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement,
    };
    const persistenceRequest = {
      requestId: request.requestId,
      sourceAgentFolder: 'main_agent',
      appId: 'default',
      agentId: 'agent:main_agent',
      jobId: 'job-1',
      targetJid: 'tg:job',
      toolName: 'RunCommand',
    };
    await expect(
      appendSetupPauseRequirementAfterPersistentGrant(
        opsRepository as never,
        persistenceRequest,
        [PERSISTENT_RUN_COMMAND_UPDATE],
      ),
    ).resolves.toBe(true);
    await expect(
      appendSetupPauseRequirementAfterPersistentGrant(
        opsRepository as never,
        persistenceRequest,
        [PERSISTENT_RUN_COMMAND_UPDATE],
      ),
    ).resolves.toBe(true);
    expect(appendJobAccessRequirement).toHaveBeenCalledOnce();
    expect(requirements).toEqual([
      {
        target: { kind: 'tool_rule', rule: 'RunCommand(npm test *)' },
        reason: 'Required after this scheduled run needed approval.',
      },
    ]);

    const nextRunDecision = new ToolExecutionPolicyService().evaluate({
      request: buildAgentToolExecutionRequest(
        new ToolExecutionClassifier(),
        'RunCommand',
        { command: 'npm test unit' },
        {
          isScheduledJob: true,
          jobId: 'job-1',
          conversationId: 'tg:job',
        },
      ),
      autonomousAllowedToolRules: [requirements[0]!.target.rule],
    });
    expect(nextRunDecision).toMatchObject({ status: 'allow' });
  } finally {
    watch.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('jobperm-1-t1-deletions-asserted', () => {
  const source = (relativePath: string) =>
    fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
  const workerSources = [
    'apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts',
    'apps/core/src/runner/permission-ipc-client.ts',
  ]
    .map(source)
    .join('\n');
  expect(workerSources).not.toMatch(/autoClassifierWait/);
  expect(workerSources).not.toMatch(/AUTO_PERMISSION_CLASSIFIER_WAIT_MS/);
  expect(workerSources).not.toContain(
    'Unattended jobs do not wait for approval during the active tool call',
  );

  const hostDecisionSource = source(
    'apps/core/src/runtime/ipc-permission-classifier-decision.ts',
  );
  expect(hostDecisionSource).not.toContain(
    'Autonomous runs decide deterministically:',
  );

  const permissionTimeout = source(
    'apps/core/src/shared/permission-timeout.ts',
  );
  expect(permissionTimeout).not.toMatch(/AUTONOMOUS_KEYS/);
  expect(permissionTimeout).not.toMatch(
    /GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS/,
  );
  expect(
    getPermissionTimeoutMs(
      'autonomous',
      {
        GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS: '1000',
        GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: '20000',
      },
      {},
    ),
  ).toBe(20_000);

  expect(ipcInteractionAuthValidationOptions('autonomous')).toEqual(
    ipcInteractionAuthValidationOptions('interactive'),
  );

  const detail = truthfulAutonomousDenialDetail({
    denialReason: 'Access for this tool was not granted.',
    recoveryMessage: 'Allowed by autonomous tool rule Browser.',
  });
  expect(detail).toBe('Access for this tool was not granted.');
  expect(detail).not.toContain('Allowed by');
});
