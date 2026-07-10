import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from '@core/runtime/ipc-interaction-handler.js';
import {
  processPermissionInteractionIpc,
  processUserQuestionInteractionIpc,
} from '@core/runtime/ipc-interaction-processing.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function createEmptyJobRepository() {
  return {
    listJobs: vi.fn(async () => []),
    getJobById: vi.fn(async () => null),
    updateJob: vi.fn(async () => null),
  };
}

describe('ipc-interaction-handler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-interaction-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    configurePendingInteractionDurability(null);
    vi.clearAllMocks();
  });

  it('delegates permission decisions through the domain handler', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'reviewer',
      reason: 'safe',
    }));

    const response = await processPermissionIpcRequest(
      {
        requestId: 'perm-1',
        sourceAgentFolder: 'main',
        toolName: 'tool-x',
      },
      { requestPermissionApproval },
    );

    expect(response).toEqual({
      approved: true,
      decidedBy: 'reviewer',
      reason: 'safe',
    });
    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('delegates user questions through the domain handler', async () => {
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-1',
      answers: { mode: 'trigger' },
      answeredBy: 'human',
    }));

    const response = await processUserQuestionIpcRequest(
      {
        requestId: 'q-1',
        sourceAgentFolder: 'main',
        questions: [
          {
            header: 'Mode',
            question: 'Pick one',
            options: [
              { label: 'Trigger', description: 'Use trigger mode' },
              { label: 'Always', description: 'Use always mode' },
            ],
            multiSelect: false,
          },
        ],
      },
      { requestUserAnswer },
    );

    expect(response).toEqual({
      requestId: 'q-1',
      answers: { mode: 'trigger' },
      answeredBy: 'human',
    });
    expect(requestUserAnswer).toHaveBeenCalledTimes(1);
  });

  it('writes permission responses to permission-responses directory', () => {
    const keys = createIpcResponseSigningKeyPair();
    writePermissionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'perm-2',
        approved: false,
        reason: 'denied',
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'permission-responses',
      'perm-2.json',
    );
    const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expect(payload).toMatchObject({
      requestId: 'perm-2',
      approved: false,
      reason: 'denied',
    });
    expect(
      verifyIpcResponsePayload(
        keys.publicKeyPem,
        { requestId: 'perm-2', approved: false, reason: 'denied' },
        payload.signature,
      ),
    ).toBe(true);
    expect(fileMode(path.dirname(responsePath))).toBe(0o700);
    expect(fileMode(responsePath)).toBe(0o400);
  });

  it('writes persistent permission metadata for runner SDK responses', () => {
    const keys = createIpcResponseSigningKeyPair();
    writePermissionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'perm-3',
        approved: true,
        mode: 'allow_persistent_rule',
        reason: 'persistent tool allowed',
        updatedPermissions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
          },
        ],
        decisionClassification: 'user_permanent',
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'permission-responses',
      'perm-3.json',
    );
    const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expect(payload).toMatchObject({
      requestId: 'perm-3',
      approved: true,
      mode: 'allow_persistent_rule',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
      ],
      decisionClassification: 'user_permanent',
    });
  });

  it('writes persistent SDK permission approvals to the active run live-rule file', async () => {
    const claimedPath = path.join(tempDir, 'claimed-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const toolRepository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
      listTools: vi.fn(async () => []),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-live-admin',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        targetJid: 'tg:team',
        toolName: 'mcp__gantry__service_restart',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'mcp__gantry__service_restart' }],
            },
          ],
        })),
        sendMessage,
        opsRepository: createEmptyJobRepository() as never,
        getToolRepository: () => toolRepository as never,
        mirrorAgentToolRulesToSettings,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            'main_agent',
            'live-tool-rules',
            'agent-run-1.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual(['mcp__gantry__service_restart']);
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['mcp__gantry__service_restart'],
      { appId: 'app:test' },
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      expect.stringContaining('Allowed for future:'),
      expect.any(Object),
    );
  });

  it('records persistent approvals at parent conversation scope while routing the receipt to the thread', async () => {
    const claimedPath = path.join(tempDir, 'claimed-thread-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const saveDecision = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    const toolRepository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
      listTools: vi.fn(async () => []),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-thread-admin',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-thread',
        targetJid: 'tg:team',
        threadId: 'topic-7',
        toolName: 'mcp__gantry__service_restart',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          reason: 'persistent tool allowed',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'mcp__gantry__service_restart' }],
            },
          ],
        })),
        sendMessage,
        publishRuntimeEvent,
        opsRepository: createEmptyJobRepository() as never,
        getToolRepository: () => toolRepository as never,
        getPermissionRepository: () =>
          ({
            savePolicy: vi.fn(),
            saveRule: vi.fn(),
            saveDecision,
            getDecision: vi.fn(),
          }) as never,
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      },
      ipcBaseDir: tempDir,
      file: 'claimed-thread-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    const savedDecision = saveDecision.mock.calls[0]?.[0];
    expect(savedDecision.actorContext).toMatchObject({
      requestId: 'perm-thread-admin',
      conversationId: 'tg:team',
      mode: 'allow_persistent_rule',
      classification: 'user_permanent',
    });
    expect(savedDecision.actorContext).not.toHaveProperty('threadId');
    const persistedEvent = publishRuntimeEvent.mock.calls
      .map((call) => call[0])
      .find((event) => event.eventType === 'permission.persisted');
    expect(persistedEvent).toEqual(
      expect.objectContaining({
        conversationId: 'tg:team',
        threadId: undefined,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      expect.stringContaining('Allowed for future:'),
      { threadId: 'topic-7' },
    );
  });

  it('persists skill action capability approvals and appends runtime command rules', async () => {
    const claimedPath = path.join(tempDir, 'claimed-skill-action.json');
    fs.writeFileSync(claimedPath, '{}');
    const skillCapability = {
      capabilityId: 'skill.linkedin-posting.publish',
      displayName: 'LinkedIn posting',
      category: 'LinkedIn posting',
      risk: 'write' as const,
      can: 'Publish posts through the selected LinkedIn posting skill.',
      cannot:
        'Use unrelated skills, credentials, settings, or broader commands.',
      credentialSource: 'skill_secret' as const,
      implementationBindings: [
        {
          kind: 'tool_rule' as const,
          rule: 'RunCommand(skills/linkedin-posting/publish *)',
        },
      ],
      preflight: { kind: 'none' as const },
      sandboxProfile: {
        network: 'required' as const,
        filesystem: 'workspace_write' as const,
      },
    };
    const toolRepository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          appId: 'app:test',
          id: 'tool:capability:skill.linkedin-posting.publish',
          name: 'capability:skill.linkedin-posting.publish',
          kind: 'host',
          provider: 'gantry',
          displayName: 'LinkedIn posting',
          category: 'productivity',
          risk: 'high',
          selectable: true,
          status: 'active',
          adapterRef: 'capability/skill.linkedin-posting.publish',
          inputSchema: semanticCapabilityInputSchema(skillCapability),
          createdAt: '2026-05-15T12:00:00.000Z',
          updatedAt: '2026-05-15T12:00:00.000Z',
        },
      ]),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-skill-action',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-skill',
        targetJid: 'tg:team',
        toolName: 'RunCommand',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
          },
        ],
        semanticCapabilityDefinitions: {
          'skill.linkedin-posting.publish': skillCapability,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [
                { toolName: 'capability:skill.linkedin-posting.publish' },
              ],
            },
          ],
        })),
        opsRepository: createEmptyJobRepository() as never,
        getToolRepository: () => toolRepository as never,
        mirrorAgentToolRulesToSettings,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-skill-action.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(toolRepository.saveTool).not.toHaveBeenCalled();
    expect(toolRepository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:test',
        toolId: 'tool:capability:skill.linkedin-posting.publish',
        status: 'active',
      }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['capability:skill.linkedin-posting.publish'],
      { appId: 'app:test' },
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            'main_agent',
            'live-tool-rules',
            'agent-run-skill.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual([
      'capability:skill.linkedin-posting.publish',
      'RunCommand(skills/linkedin-posting/publish *)',
    ]);
  });

  it('strips live-rule updates from non-permanent permission IPC responses', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-allow-once.json');
    fs.writeFileSync(claimedPath, '{}');

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-once',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-once',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-once',
        targetJid: 'tg:team',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'owner',
          decisionClassification: 'user_temporary',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
            },
          ],
        })),
      },
      ipcBaseDir: tempDir,
      file: 'claimed-allow-once.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-once.json',
        ),
        'utf-8',
      ),
    );
    expect(response).toMatchObject({
      requestId: 'perm-once',
      approved: true,
      mode: 'allow_once',
      decisionClassification: 'user_temporary',
    });
    expect(response.updatedPermissions).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'live-tool-rules',
          'agent-run-once.json',
        ),
      ),
    ).toBe(false);
  });

  it('emits structured permission events and redacted Bash command telemetry', async () => {
    const claimedPath = path.join(tempDir, 'claimed-bash-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const createTransientGrant = vi.fn(async () => true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run:test',
          jobId: 'job:test',
          workerInstanceId: 'worker-1',
          leaseToken: 'lease-token',
          fencingVersion: 7,
          status: 'active',
          claimedAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-10T00:05:00.000Z',
          heartbeatAt: '2026-06-10T00:00:00.000Z',
        })),
        createPendingInteraction: vi.fn(async () => true),
        resolvePendingInteraction: vi.fn(async () => true),
        createTransientGrant,
      } as never,
    });
    const command =
      'OPENAI_API_KEY=sk-ant-testtoken123456789012345 npm test -- --runInBand';

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-bash-once',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        threadId: 'thread:test',
        toolName: 'Bash',
        toolInput: { command },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'owner',
          reason: 'safe for this run',
          decisionClassification: 'user_temporary',
        })),
        publishRuntimeEvent,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-bash-permission.json',
      claimedPath,
      logger,
    });

    expect(
      publishRuntimeEvent.mock.calls.map((call) => call[0].eventType),
    ).toEqual([
      'permission.requested',
      'permission.allowed',
      'permission.resumed',
      'permission.final_outcome',
    ]);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:test',
        runId: 'run:test',
        jobId: 'job:test',
        conversationId: 'tg:team',
        threadId: 'thread:test',
        correlationId: 'perm-bash-once',
        payload: expect.objectContaining({
          toolName: 'Bash',
          canonicalCapability: 'Bash',
          commandPreview:
            'OPENAI_API_KEY=[REDACTED_SECRET] npm test -- --runInBand',
          commandHash: expect.any(String),
        }),
      }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('sk-ant');
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
      'sk-ant',
    );
    expect(createTransientGrant).toHaveBeenCalledOnce();
  });

  it('does not prompt or resume scheduled permission IPC when the run lease is stale', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-stale-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'owner',
      decisionClassification: 'user_temporary',
    }));
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 8,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      })),
      createPendingInteraction: vi.fn(async () => true),
      resolvePendingInteraction: vi.fn(async () => true),
      createTransientGrant: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-stale-run',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-stale',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        runLeaseToken: 'old-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-stale-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(repository.createTransientGrant).not.toHaveBeenCalled();
    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'cancelled',
        resolution: expect.objectContaining({ approved: false }),
      }),
    );
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-stale-run.json',
        ),
      ),
    ).toBe(false);
  });

  it('does not prompt or answer scheduled question IPC when the run lease is stale', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-stale-question.json');
    fs.writeFileSync(claimedPath, '{}');
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'userq-stale-run',
      answers: { mode: 'retry' },
      answeredBy: 'owner',
    }));
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 8,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      })),
      createPendingInteraction: vi.fn(async () => true),
      resolvePendingInteraction: vi.fn(async () => true),
      createTransientGrant: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await processUserQuestionInteractionIpc({
      request: {
        requestId: 'userq-stale-run',
        appId: 'app:test',
        agentId: 'agent:test',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runId: 'run:test',
        runLeaseToken: 'old-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        questions: [
          {
            header: 'Mode',
            question: 'Pick one',
            options: [
              { label: 'Retry', description: 'Try again' },
              { label: 'Stop', description: 'Stop now' },
            ],
            multiSelect: false,
          },
        ],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestUserAnswer,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-stale-question.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestUserAnswer).not.toHaveBeenCalled();
    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'cancelled',
        resolution: expect.objectContaining({ answers: {} }),
      }),
    );
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'user-answers',
          'userq-stale-run.json',
        ),
      ),
    ).toBe(false);
  });

  it('does not write a scheduled permission response when durable resolution fails', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(
      tempDir,
      'claimed-unresolved-permission.json',
    );
    fs.writeFileSync(claimedPath, '{}');
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run:test',
          jobId: 'job:test',
          workerInstanceId: 'worker-1',
          leaseToken: 'lease-token',
          fencingVersion: 7,
          status: 'active',
          claimedAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-10T00:05:00.000Z',
          heartbeatAt: '2026-06-10T00:00:00.000Z',
        })),
        createPendingInteraction: vi.fn(async () => true),
        resolvePendingInteraction: vi.fn(async () => false),
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-unresolved-run',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-unresolved',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          decisionClassification: 'user_reject',
        })),
      },
      ipcBaseDir: tempDir,
      file: 'claimed-unresolved-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-unresolved-run.json',
        ),
      ),
    ).toBe(false);
  });

  it('does not write scheduled question answers when durable resolution fails', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-unresolved-question.json');
    fs.writeFileSync(claimedPath, '{}');
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run:test',
          jobId: 'job:test',
          workerInstanceId: 'worker-1',
          leaseToken: 'lease-token',
          fencingVersion: 7,
          status: 'active',
          claimedAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-10T00:05:00.000Z',
          heartbeatAt: '2026-06-10T00:00:00.000Z',
        })),
        createPendingInteraction: vi.fn(async () => true),
        resolvePendingInteraction: vi.fn(async () => false),
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });

    await processUserQuestionInteractionIpc({
      request: {
        requestId: 'userq-unresolved-run',
        appId: 'app:test',
        agentId: 'agent:test',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runId: 'run:test',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        questions: [
          {
            header: 'Mode',
            question: 'Pick one',
            options: [
              { label: 'Retry', description: 'Try again' },
              { label: 'Stop', description: 'Stop now' },
            ],
            multiSelect: false,
          },
        ],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestUserAnswer: vi.fn(async () => ({
          requestId: 'userq-unresolved-run',
          answers: { mode: 'retry' },
          answeredBy: 'owner',
        })),
      },
      ipcBaseDir: tempDir,
      file: 'claimed-unresolved-question.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'user-answers',
          'userq-unresolved-run.json',
        ),
      ),
    ).toBe(false);
  });

  it('does not write scheduled question answers after lease recovery', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-recovered-question.json');
    fs.writeFileSync(claimedPath, '{}');
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'userq-recovered-run',
      answers: { mode: 'retry' },
      answeredBy: 'owner',
    }));
    const getActiveRunLease = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-1',
        leaseToken: 'old-token',
        fencingVersion: 7,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      })
      .mockResolvedValue({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 8,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      });
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease,
        createPendingInteraction: vi.fn(async () => true),
        resolvePendingInteraction: vi.fn(async () => true),
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });

    await processUserQuestionInteractionIpc({
      request: {
        requestId: 'userq-recovered-run',
        appId: 'app:test',
        agentId: 'agent:test',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runId: 'run:test',
        runLeaseToken: 'old-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        questions: [
          {
            header: 'Mode',
            question: 'Pick one',
            options: [
              { label: 'Retry', description: 'Try again' },
              { label: 'Stop', description: 'Stop now' },
            ],
            multiSelect: false,
          },
        ],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestUserAnswer,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-recovered-question.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestUserAnswer).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'user-answers',
          'userq-recovered-run.json',
        ),
      ),
    ).toBe(false);
  });

  it('does not write a denied scheduled permission response after lease recovery', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-recovered-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      mode: 'cancel',
      decidedBy: 'owner',
      decisionClassification: 'user_reject',
    }));
    const getActiveRunLease = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-1',
        leaseToken: 'old-token',
        fencingVersion: 7,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      })
      .mockResolvedValue({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 8,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      });
    const repository = {
      getActiveRunLease,
      createPendingInteraction: vi.fn(async () => true),
      resolvePendingInteraction: vi.fn(async () => true),
      createTransientGrant: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-recovered-run',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-recovered',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        runLeaseToken: 'old-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-recovered-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    expect(repository.createTransientGrant).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-recovered-run.json',
        ),
      ),
    ).toBe(false);
  });

  it('rechecks the scheduled run lease before persistent permission mutation', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-response-race.json');
    fs.writeFileSync(claimedPath, '{}');
    const getActiveRunLease = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-1',
        leaseToken: 'old-token',
        fencingVersion: 7,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-1',
        leaseToken: 'old-token',
        fencingVersion: 7,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      })
      .mockResolvedValue({
        runId: 'run:test',
        jobId: 'job:test',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 8,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      });
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease,
        createPendingInteraction: vi.fn(async () => true),
        resolvePendingInteraction: vi.fn(async () => true),
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });
    const toolRepository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
      listTools: vi.fn(async () => []),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-response-race',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-response-race',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        runLeaseToken: 'old-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        toolName: 'mcp__gantry__service_restart',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'mcp__gantry__service_restart' }],
            },
          ],
        })),
        sendMessage: vi.fn(async () => undefined),
        getToolRepository: () => toolRepository as never,
        mirrorAgentToolRulesToSettings,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-response-race.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(toolRepository.saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-response-race.json',
        ),
      ),
    ).toBe(false);
  });

  it('sanitizes user answer keys and values when writing responses', () => {
    const keys = createIpcResponseSigningKeyPair();
    const answers = {
      mode: 'trigger',
      '': 'ignored',
      multi: ['a', 'b', 5, 'c'],
    } as unknown as Record<string, string | string[]>;

    writeUserQuestionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'q-2',
        answers,
        answeredBy: 'user',
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(tempDir, 'grp', 'user-answers', 'q-2.json');
    const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expect(payload).toMatchObject({
      requestId: 'q-2',
      answers: {
        mode: 'trigger',
        multi: ['a', 'b', 'c'],
      },
      answeredBy: 'user',
    });
    expect(fileMode(path.dirname(responsePath))).toBe(0o700);
    expect(fileMode(responsePath)).toBe(0o400);
  });
});
