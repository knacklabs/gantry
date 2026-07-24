import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { agentIdForFolder } from '@core/domain/agent/agent-folder-id.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import type {
  PendingInteraction,
  PendingInteractionRepository,
} from '@core/domain/ports/worker-coordination.js';
import type {
  QuestionRecoveryEnvelope,
  UserQuestionRequest,
} from '@core/domain/types.js';
import { getOperationalErrorCount } from '@core/shared/operational-error-counters.js';

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
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import {
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  DurableInteractionPersistenceError,
} from '@core/application/interactions/pending-interaction-durability.js';

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

function promptPermissionRuntimeSettings() {
  return {
    agents: { main_agent: { permissionMode: 'ask' as const } },
    permissions: {
      autoMode: {},
      trustedRoots: [resolveWorkspaceFolderPath('main_agent')],
    },
    memory: { llm: { models: { extractor: 'sonnet' } } },
  };
}

const GITHUB_REPOS_READ_CAPABILITY_ID = 'github.repos.read';
const GITHUB_REPOS_LIST_TOOL_NAME = 'mcp__github__repos_list';

function createReviewedGithubReadToolRepository(appId: string) {
  return {
    listAgentToolBindings: async () => [
      {
        status: 'active',
        toolId: `tool:capability:${GITHUB_REPOS_READ_CAPABILITY_ID}`,
      },
    ],
    getTool: async () => ({
      appId,
      name: `capability:${GITHUB_REPOS_READ_CAPABILITY_ID}`,
      inputSchema: semanticCapabilityInputSchema({
        capabilityId: GITHUB_REPOS_READ_CAPABILITY_ID,
        displayName: 'GitHub repositories read',
        category: 'GitHub',
        risk: 'read',
        can: 'List GitHub repositories.',
        cannot: 'Mutate GitHub repositories.',
        credentialSource: 'none',
        implementationBindings: [
          {
            kind: 'mcp_pattern',
            mcpServer: 'github',
            mcpToolPatterns: ['repos_list'],
          },
        ],
      }),
    }),
  };
}

function durableQuestionInteraction(input: {
  request: UserQuestionRequest;
  envelope: QuestionRecoveryEnvelope;
  status?: 'pending' | 'resolved';
  resolvedAnswers?: Record<string, string | string[]>;
}): PendingInteraction {
  const status = input.status ?? 'pending';
  return {
    id: `interaction-${input.request.requestId}`,
    appId: input.request.appId || 'default',
    runId: input.request.runId ?? null,
    kind: 'question',
    status,
    payload: {
      sourceAgentFolder: input.request.sourceAgentFolder,
      requestId: input.request.requestId,
      questionRecoveryEnvelope: input.envelope,
    },
    callbackRoute: null,
    idempotencyKey: `${input.request.appId || 'default'}:question:${input.request.sourceAgentFolder}:${input.request.requestId}`,
    approverRef: status === 'resolved' ? 'owner' : null,
    resolution:
      status === 'resolved' ? { answers: input.resolvedAnswers ?? {} } : null,
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
    resolvedAt: status === 'resolved' ? '2026-07-17T00:01:00.000Z' : null,
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
    vi.restoreAllMocks();
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
        toolInput: { service: 'api' },
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
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('records persistent approvals at parent conversation scope and reports only a remaining setup blocker', async () => {
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
        toolInput: { service: 'api' },
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
        opsRepository: {
          listJobs: vi.fn(async () => [
            {
              id: 'job-still-blocked',
              name: 'Lead sync',
              workspace_key: 'main_agent',
              status: 'paused',
              pause_reason: 'Setup required',
              setup_state: { state: 'blocked' },
              recovery_intent: { state: 'running' },
            },
          ]),
          getJobById: vi.fn(async () => null),
          updateJob: vi.fn(async () => null),
        } as never,
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
      'Still needs setup: Recovery is already running for this job.',
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
        toolInput: {
          command: 'skills/linkedin-posting/publish post-1',
        },
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
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
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
    const incrementAndGet = vi.fn(async () => ({
      appId: 'app:test',
      agentFolder: 'main_agent',
      suggestionKey: 'main_agent|RunCommand(npm test)',
      allowCount: 1,
      lastOfferedAt: null,
      deniedAt: null,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }));

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
        toolInput: { command: 'npm test' },
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
        getPermissionPromotionRepository: () => ({
          incrementAndGet,
          get: vi.fn(async () => null),
          markOffered: vi.fn(async () => false),
          markDenied: vi.fn(async () => undefined),
        }),
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
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
    await vi.waitFor(() => expect(incrementAndGet).toHaveBeenCalledOnce());
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

  it('auto-allows an eligible IPC request without requester gating', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-auto-allow.json');
    fs.writeFileSync(claimedPath, '{}');
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'The read-only tool matches the turn intent.',
      latencyMs: 6,
    }));
    const requestPermissionApproval = vi.fn();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-auto-allow',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-auto',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:auto',
        senderId: 'approver-1',
        toolName: GITHUB_REPOS_LIST_TOOL_NAME,
        toolInput: { owner: 'cawstudios' },
        decisionReason: 'No allow rule matched.',
        turnIntentSummary: 'Inspect the current worktree.',
        description: 'Create a spreadsheet.',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:auto': {
            folder: 'main_agent',
            agentConfig: {},
            conversationKind: 'dm',
          },
        }),
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: {
              permissionMode: 'auto',
              capabilities: [
                { id: GITHUB_REPOS_READ_CAPABILITY_ID, version: '1' },
              ],
            },
          },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
        getToolRepository: () =>
          createReviewedGithubReadToolRepository('app:test'),
      } as never,
      ipcBaseDir: tempDir,
      file: 'claimed-auto-allow.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            'main_agent',
            'permission-responses',
            'perm-auto-allow.json',
          ),
          'utf-8',
        ),
      ),
    ).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'reviewed_rule',
      decisionClassification: 'user_temporary',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.allowed',
        payload: expect.objectContaining({
          decision: 'allowed',
          decidedBy: 'reviewed_rule',
        }),
      }),
    );
  });

  it('honors a conversation override on the live agent-qualified route key', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'The tool matches the turn intent.',
      latencyMs: 5,
    }));
    const requestPermissionApproval = vi.fn();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const targetJid = 'tg:-1003798366047';
    const sourceAgentFolder = 'main_agent';
    const routeKey = makeAgentThreadQueueKey(
      targetJid,
      agentIdForFolder(sourceAgentFolder),
    );

    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-live-route-override',
        sourceAgentFolder,
        runId: 'run:runner-supplied',
        targetJid,
        senderId: 'approver-1',
        toolName: GITHUB_REPOS_LIST_TOOL_NAME,
        toolInput: { owner: 'cawstudios' },
        turnIntentSummary: 'Inspect the worktree.',
        description: 'Create a spreadsheet.',
      },
      sourceAgentFolder,
      deps: {
        conversationRoutes: () => ({
          [routeKey]: {
            name: 'Gantry',
            folder: sourceAgentFolder,
            trigger: '@Gantry',
            added_at: '2026-07-12T00:00:00.000Z',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'dm',
          },
        }),
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: {
              capabilities: [
                { id: GITHUB_REPOS_READ_CAPABILITY_ID, version: '1' },
              ],
            },
          },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
        getToolRepository: () =>
          createReviewedGithubReadToolRepository('default'),
      } as never,
    });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'reviewed_rule',
    });
  });

  it('consults for a deterministic-safe unattended job without requester gating', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Approved capability read.',
      latencyMs: 1,
    }));
    const requestPermissionApproval = vi.fn();
    const publishRuntimeEvent = vi.fn(async () => undefined);

    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-unattended-trusted',
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:trusted-gate',
        unattended: true,
        jobId: 'job-1',
        toolName: 'mcp__crm__read',
        toolInput: { id: 'crm-1' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:trusted-gate': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'channel',
          },
        }),
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: {
              capabilities: [{ id: 'mcp.crm.positions.read', version: '1' }],
            },
          },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
        getToolRepository: () => ({
          listAgentToolBindings: async () => [
            {
              status: 'active',
              toolId: 'tool:capability:mcp.crm.positions.read',
            },
          ],
          getTool: async () => ({
            appId: 'default',
            name: 'capability:mcp.crm.positions.read',
            inputSchema: semanticCapabilityInputSchema({
              capabilityId: 'mcp.crm.positions.read',
              displayName: 'CRM positions read',
              category: 'CRM',
              risk: 'read',
              can: 'Read CRM positions.',
              cannot: 'Mutate CRM positions.',
              credentialSource: 'none',
              implementationBindings: [
                {
                  kind: 'mcp_pattern',
                  mcpServer: 'crm',
                  mcpToolPatterns: ['read'],
                },
              ],
            }),
          }),
        }),
      } as never,
    });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'reviewed_rule',
    });
  });

  it('routes an unattended mutation ASK rail through the classifier tail', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'high' as const,
      reason: 'Destructive filesystem mutation.',
      latencyMs: 1,
    }));
    const requestPermissionApproval = vi.fn();
    const publishRuntimeEvent = vi.fn(async () => undefined);

    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-unattended-mutation',
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:unattended',
        unattended: true,
        jobId: 'job-1',
        toolName: 'RunCommand',
        toolInput: { command: 'rm report.txt' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:unattended': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'channel',
          },
        }),
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: {
              capabilities: [{ id: 'shell.execute', version: '1' }],
            },
          },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(classifierConsult).toHaveBeenCalledOnce();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toEqual({
      approved: false,
      mode: 'cancel',
      decidedBy: 'runtime',
      reason:
        'Classifier requested human approval: Destructive filesystem mutation.',
      decisionClassification: 'user_reject',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'permission.classifier_decision' }),
    );
  });

  it('writes the classifier verdict back on a cache miss (attended auto allow)', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Reversible workspace mutation.',
      latencyMs: 1,
    }));
    const putClassifierVerdict = vi.fn(async () => undefined);
    const getClassifierVerdict = vi.fn(async () => null);

    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-cache-miss-writeback',
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:attended',
        toolName: 'RunCommand',
        toolInput: { command: 'rm report.txt' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:attended': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'dm',
          },
        }),
        requestPermissionApproval: vi.fn(),
        classifierConsult,
        publishRuntimeEvent: vi.fn(async () => undefined),
        getPermissionDecisionMemoryRepository: () => ({
          list: async () => [],
          getClassifierVerdict,
          putClassifierVerdict,
        }),
        getPermissionRuntimeSettings: () => ({
          agents: {},
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(classifierConsult).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
    });
    expect(putClassifierVerdict).toHaveBeenCalledOnce();
    expect(putClassifierVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentFolder: 'main_agent',
        decision: 'allow',
        reason: 'Reversible workspace mutation.',
        provenance: 'classifier',
        effectHash: expect.any(String),
      }),
    );
  });

  it('never writes a human allow_once decision back to the cache', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once' as const,
      decidedBy: 'owner',
    }));
    const putClassifierVerdict = vi.fn(async () => undefined);

    await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-human-allow-once',
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
        toolInput: { command: 'rm report.txt' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({}),
        requestPermissionApproval,
        getPermissionDecisionMemoryRepository: () => ({
          list: async () => [],
          getClassifierVerdict: vi.fn(async () => null),
          putClassifierVerdict,
        }),
        getPermissionRuntimeSettings: () => ({
          agents: { main_agent: { permissionMode: 'ask' as const } },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(putClassifierVerdict).not.toHaveBeenCalled();
  });

  it('writes the classifier verdict when display sanitization leaves the full command intact', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Reversible workspace mutation.',
      latencyMs: 1,
    }));
    const putClassifierVerdict = vi.fn(async () => undefined);
    const getClassifierVerdict = vi.fn(async () => null);

    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-sanitized-no-hash',
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:attended',
        toolName: 'RunCommand',
        toolInput: { command: 'rm report.txt' },
        toolInputSanitized: true,
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:attended': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'dm',
          },
        }),
        requestPermissionApproval: vi.fn(),
        classifierConsult,
        publishRuntimeEvent: vi.fn(async () => undefined),
        getPermissionDecisionMemoryRepository: () => ({
          list: async () => [],
          getClassifierVerdict,
          putClassifierVerdict,
        }),
        getPermissionRuntimeSettings: () => ({
          agents: {},
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(decision).toMatchObject({ decidedBy: 'auto_classifier' });
    // The destructive ASK rail bypasses cache reads, but the intact command is
    // still cacheable for the classifier writeback path.
    expect(getClassifierVerdict).not.toHaveBeenCalled();
    expect(putClassifierVerdict).toHaveBeenCalledOnce();
  });

  it('denies an unattended read-only command matched by the YOLO denylist backstop', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Read-only workspace file.',
      latencyMs: 1,
    }));
    const requestPermissionApproval = vi.fn();

    const decision = await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-unattended-yolo-denylist',
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:unattended',
        unattended: true,
        jobId: 'job-1',
        toolName: 'Bash',
        toolInput: { command: 'cat README.md' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:unattended': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'channel',
          },
        }),
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent: vi.fn(async () => undefined),
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: {
              capabilities: [{ id: 'filesystem.read', version: '1' }],
            },
          },
          permissions: {
            autoMode: {},
            yoloMode: {
              enabled: true,
              denylist: ['cat README.md'],
              denylistPaths: [],
            },
          },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'hard_deny',
      reason: expect.stringContaining('YOLO-mode denylist rule matched'),
    });
  });

  it('promotes the persistent option when IPC omits decision options', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'owner',
    }));
    const counter = {
      appId: 'app:test',
      agentFolder: 'main_agent',
      suggestionKey: 'main_agent|RunCommand(git status)',
      allowCount: 2,
      lastOfferedAt: null,
      deniedAt: null,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };

    await resolvePermissionIpcDecision({
      request: {
        requestId: 'perm-ask-hint',
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
        toolInput: { command: 'git status' },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'RunCommand', ruleContent: 'git status' }],
          },
        ],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({}),
        requestPermissionApproval,
        getPermissionPromotionRepository: () => ({
          incrementAndGet: vi.fn(),
          get: vi.fn(async () => counter),
          markOffered: vi.fn(),
          markDenied: vi.fn(),
        }),
        getPermissionRuntimeSettings: () => ({
          agents: { main_agent: { permissionMode: 'ask' } },
          permissions: {
            autoMode: {},
            trustedRoots: [resolveWorkspaceFolderPath('main_agent')],
          },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        promotionHintCount: 2,
        decisionOptions: ['allow_persistent_rule', 'allow_once', 'cancel'],
      }),
    );
  });

  it('routes display-sanitized IPC input through the classifier tail', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-auto-ask.json');
    fs.writeFileSync(claimedPath, '{}');
    const fullCommand = `printf '%s' '${'x'.repeat(600)}'`;
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Benign command.',
      latencyMs: 1,
    }));
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'owner',
      decisionClassification: 'user_reject' as const,
    }));
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-auto-ask',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-auto-ask',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:auto',
        senderId: 'approver-1',
        toolName: 'RunCommand',
        toolInput: { command: `${fullCommand.slice(0, 500)}...[truncated]` },
        classifierToolInput: { command: fullCommand },
        toolInputSanitized: true,
        toolInputSanitizedPaths: ['command'],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:auto': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'dm',
          },
        }),
        requestPermissionApproval,
        isControlApproverAllowed: vi.fn(async () => true),
        getPermissionMessageRepository: () => ({
          getRecentTopLevelMessagesBefore: vi.fn(async () => [
            {
              content: 'Read CRM record crm-1.',
              sender: 'approver-1',
              is_from_me: false,
              is_bot_message: false,
            },
          ]),
          getLatestThreadMessages: vi.fn(),
        }),
        classifierConsult,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {},
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
      ipcBaseDir: tempDir,
      file: 'claimed-auto-ask.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(classifierConsult).toHaveBeenCalledOnce();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-auto-ask.json',
        ),
        'utf-8',
      ),
    );
    expect(response).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'permission.classifier_decision' }),
    );
  });

  it('fails closed in the unattended tail for secret-redacted auto input', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-unattended-ask.json');
    fs.writeFileSync(claimedPath, '{}');
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Would allow if consulted.',
      latencyMs: 1,
    }));
    const requestPermissionApproval = vi.fn();
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-unattended-ask',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-unattended-ask',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:auto',
        jobId: 'job:auto',
        toolName: 'RunCommand',
        unattended: true,
        toolInput: { command: "curl -H 'Authorization: [REDACTED]'" },
        classifierToolInput: {
          command: "curl -H 'Authorization: [REDACTED]'",
        },
        toolInputSanitized: true,
        toolInputSanitizedPaths: ['command'],
        toolInputRedactedPaths: ['command'],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:auto': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'channel',
          },
        }),
        requestPermissionApproval,
        classifierConsult,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {},
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
      ipcBaseDir: tempDir,
      file: 'claimed-unattended-ask.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            'main_agent',
            'permission-responses',
            'perm-unattended-ask.json',
          ),
          'utf-8',
        ),
      ),
    ).toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'runtime',
      reason:
        'Classifier requested human approval: Classifier skipped because its tool input view was incomplete; ask the user.',
      decisionClassification: 'user_reject',
    });
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-unattended-ask.json',
        ),
        'utf-8',
      ),
    );
    expect(response.mode).toBe('cancel');
    expect(response.decisionClassification).toBe('user_reject');
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'permission.classifier_decision' }),
    );
  });

  it.each([
    ['auto', 'mcp__gantry__request_access', true],
    ['ask', 'Bash', false],
  ] as const)(
    'does not consult mode %s for %s when eligibility/mode excludes it',
    async (permissionMode, toolName, unattended) => {
      const envelope = createIpcAuthEnvelope('main_agent', null);
      const requestId = `perm-no-consult-${permissionMode}`;
      const claimedPath = path.join(tempDir, `${requestId}.json`);
      fs.writeFileSync(claimedPath, '{}');
      const classifierConsult = vi.fn();
      const requestPermissionApproval = vi.fn(async () => ({
        approved: false,
        mode: 'cancel' as const,
        decisionClassification: 'user_reject' as const,
      }));

      await processPermissionInteractionIpc({
        request: {
          requestId,
          appId: 'app:test',
          agentId: 'agent:test',
          responseNonce: `nonce-${permissionMode}`,
          responseKeyId: envelope.responseKeyId,
          sourceAgentFolder: 'main_agent',
          targetJid: 'tg:auto',
          toolName,
          unattended,
          toolInput: { command: 'npm test' },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: () => ({
            'tg:auto': {
              folder: 'main_agent',
              agentConfig: { permissionMode },
            },
          }),
          requestPermissionApproval,
          classifierConsult,
          publishRuntimeEvent: vi.fn(async () => undefined),
          getPermissionRuntimeSettings: () => ({
            agents: {},
            permissions: {
              autoMode: {},
              trustedRoots: [resolveWorkspaceFolderPath('main_agent')],
            },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
        ipcBaseDir: tempDir,
        file: `${requestId}.json`,
        claimedPath,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      });

      expect(classifierConsult).not.toHaveBeenCalled();
      if (unattended) {
        expect(requestPermissionApproval).not.toHaveBeenCalled();
      } else {
        expect(requestPermissionApproval).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(['Bash', 'RunCommand'])(
    'emits structured permission events, decision reasons, and redacted %s command telemetry',
    async (toolName) => {
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
          findPendingPermissionPromptByMember: vi.fn(async () => null),
          listPendingInteractions: vi.fn(async () => []),
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
          toolName,
          decisionReason: 'No allow rule matched.',
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
        'interaction.pending',
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
            toolName,
            canonicalCapability: toolName,
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
      // The ASK rail routes to the human tail: the request carries the
      // rail/rule reason; the resolved allow carries the approver's reason.
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'permission.requested',
          payload: expect.objectContaining({
            decisionReason: 'No allow rule matched.',
          }),
        }),
      );
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'permission.allowed',
          payload: expect.objectContaining({
            decisionReason: expect.stringContaining(
              'environment assignments are not supported',
            ),
          }),
        }),
      );
      // allow_once approval creates one run-scoped transient grant (the old
      // ASK->deny bug created none).
      expect(createTransientGrant).toHaveBeenCalledTimes(1);
    },
  );

  it('releases a live callback claim when grant application fails so retry can claim it', async () => {
    const claimedPath = path.join(tempDir, 'claimed-failed-grant.json');
    fs.writeFileSync(claimedPath, '{}');
    const claim = {
      id: 'claim-failed-grant',
      scope: {
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        interactionId: 'interaction-failed-grant',
      },
    };
    let claimHeld = true;
    const releasePendingPermissionCallback = vi.fn(async () => {
      claimHeld = false;
      return 1;
    });
    const repository = {
      createPendingInteraction: vi.fn(async () => true),
      findPendingPermissionPromptByMember: vi.fn(async () => null),
      listPendingInteractions: vi.fn(async () => []),
      claimPendingPermissionCallback: vi.fn(async () => {
        if (claimHeld) return null;
        claimHeld = true;
        return { prompt: { claim: null }, members: [] };
      }),
      releasePendingPermissionCallback,
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-failed-grant',
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          decisionClassification: 'user_permanent',
          permissionCallbackClaim: claim,
        })),
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-failed-grant.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(releasePendingPermissionCallback).toHaveBeenCalledWith({ claim });
    await expect(
      claimPermissionInteractionCallback({
        scope: claim.scope,
        mode: 'allow_persistent_rule',
        approverRef: 'owner',
        matchKind: 'individual',
        claimId: 'claim-failed-grant-retry',
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
  });

  it('replays a decided Review-each member after restart without opening a fresh prompt', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-replayed-decision.json');
    fs.writeFileSync(claimedPath, '{}');
    const request = {
      requestId: 'perm-replayed-decision',
      appId: 'app:replay',
      agentId: 'agent:test',
      responseNonce: 'nonce-replayed-decision',
      responseKeyId: envelope.responseKeyId,
      sourceAgentFolder: 'main_agent',
      runId: 'run:replay',
      runLeaseToken: 'lease-replay',
      runLeaseFencingVersion: 3,
      targetJid: 'tg:prompt-target',
      approvalContextJid: 'tg:approval-context',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    } as const;
    const scope = {
      appId: request.appId,
      sourceAgentFolder: request.sourceAgentFolder,
      interactionId: request.requestId,
    };
    const persistedClaim = {
      id: 'claim-replayed-decision',
      scope,
      intent: {
        mode: 'allow_once' as const,
        approverRef: 'owner',
        decidedAt: '2026-07-17T00:00:00.000Z',
      },
      match: {
        kind: 'individual' as const,
        canonicalId: request.requestId,
        providerAliases: ['provider:member-0'],
      },
    };
    const activeLease = {
      runId: request.runId,
      jobId: null,
      workerInstanceId: 'worker-replay',
      leaseToken: request.runLeaseToken,
      fencingVersion: request.runLeaseFencingVersion,
      status: 'active',
      claimedAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T01:00:00.000Z',
      heartbeatAt: '2026-07-17T00:00:00.000Z',
    } as const;
    const pending = {
      id: 'pending-replayed-decision',
      appId: request.appId,
      runId: request.runId,
      sourceAgentFolder: request.sourceAgentFolder,
      requestId: request.requestId,
      runLeaseToken: request.runLeaseToken,
      runLeaseFencingVersion: request.runLeaseFencingVersion,
      envelopeId: 'prompt-replayed-decision',
      memberIndex: 0,
      kind: 'permission',
      status: 'pending',
      payload: { request },
      callbackRoute: null,
      idempotencyKey: `${request.appId}:permission:${request.sourceAgentFolder}:${request.requestId}`,
      approverRef: null,
      resolution: null,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-18T00:00:00.000Z',
      resolvedAt: null,
    } as const;
    const findPendingPermissionPromptByMember = vi.fn(async (input: any) =>
      input.appId === request.appId &&
      input.sourceAgentFolder === request.sourceAgentFolder &&
      input.requestId === request.requestId
        ? {
            prompt: {
              id: pending.envelopeId,
              appId: request.appId,
              sourceAgentFolder: request.sourceAgentFolder,
              interactionId: request.requestId,
              claim: persistedClaim,
              settlementState: 'claimed',
            },
            members: [pending],
          }
        : null,
    );
    const createTransientGrant = vi.fn(async () => true);
    const resolvePendingInteraction = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => true),
        findPendingPermissionPromptByMember,
        getActiveRunLease: vi.fn(async () => activeLease),
        createTransientGrant,
        resolvePendingInteraction,
      } as never,
    });
    const requestPermissionApproval = vi.fn();

    await processPermissionInteractionIpc({
      request,
      sourceAgentFolder: request.sourceAgentFolder,
      deps: { requestPermissionApproval },
      ipcBaseDir: tempDir,
      file: 'claimed-replayed-decision.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(findPendingPermissionPromptByMember).toHaveBeenCalledWith({
      appId: request.appId,
      sourceAgentFolder: request.sourceAgentFolder,
      requestId: request.requestId,
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(createTransientGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: request.appId,
        runId: request.runId,
        leaseToken: request.runLeaseToken,
        grant: expect.objectContaining({
          toolName: request.toolName,
          mode: 'allow_once',
          requestId: request.requestId,
        }),
      }),
    );
    expect(resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionCallbackClaim: {
          id: persistedClaim.id,
          scope,
        },
        resolution: expect.objectContaining({
          approved: true,
          mode: 'allow_once',
        }),
      }),
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            request.sourceAgentFolder,
            'permission-responses',
            `${request.requestId}.json`,
          ),
          'utf-8',
        ),
      ),
    ).toMatchObject({
      requestId: request.requestId,
      approved: true,
      mode: 'allow_once',
      decidedBy: persistedClaim.intent.approverRef,
    });
  });

  it('preserves a callback claim when processing throws after grant application', async () => {
    const claimedPath = path.join(tempDir, 'claimed-thrown-decision.json');
    fs.writeFileSync(claimedPath, '{}');
    const claim = {
      id: 'claim-thrown-decision',
      scope: {
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        interactionId: 'interaction-thrown-decision',
      },
    };
    const releasePendingPermissionCallback = vi.fn(async () => 1);
    const publishRuntimeEvent = vi.fn(async (event) => {
      if (event.eventType === 'permission.allowed') {
        throw new Error('simulated post-decision failure');
      }
    });
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => true),
        releasePendingPermissionCallback,
      } as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-thrown-decision',
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'owner',
          permissionCallbackClaim: claim,
        })),
        publishRuntimeEvent,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-thrown-decision.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(releasePendingPermissionCallback).not.toHaveBeenCalled();
  });

  it('releases a callback claim when the scheduled lease becomes stale after the decision', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-stale-after-decision.json');
    fs.writeFileSync(claimedPath, '{}');
    const claim = {
      id: 'claim-stale-after-decision',
      scope: {
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        interactionId: 'interaction-stale-after-decision',
      },
    };
    const activeLease = {
      runId: 'run:test',
      jobId: 'job:test',
      workerInstanceId: 'worker-1',
      leaseToken: 'lease-token',
      fencingVersion: 7,
      status: 'active',
      claimedAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-10T00:05:00.000Z',
      heartbeatAt: '2026-06-10T00:00:00.000Z',
    } as const;
    const releasePendingPermissionCallback = vi.fn(async () => 1);
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => true),
        findPendingPermissionPromptByMember: vi.fn(async () => null),
        listPendingInteractions: vi.fn(async () => []),
        getActiveRunLease: vi
          .fn()
          .mockResolvedValueOnce(activeLease)
          .mockResolvedValueOnce(null),
        releasePendingPermissionCallback,
      } as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-stale-after-decision',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-stale-after-decision',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runId: 'run:test',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          permissionCallbackClaim: claim,
        })),
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-stale-after-decision.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(releasePendingPermissionCallback).toHaveBeenCalledWith({ claim });
  });

  it('does not release a callback claim after durable settlement succeeds', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-stale-after-settle.json');
    fs.writeFileSync(claimedPath, '{}');
    const claim = {
      id: 'claim-stale-after-settle',
      scope: {
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        interactionId: 'interaction-stale-after-settle',
      },
    };
    const activeLease = {
      runId: 'run:test',
      jobId: 'job:test',
      workerInstanceId: 'worker-1',
      leaseToken: 'lease-token',
      fencingVersion: 7,
      status: 'active',
      claimedAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-10T00:05:00.000Z',
      heartbeatAt: '2026-06-10T00:00:00.000Z',
    } as const;
    const releasePendingPermissionCallback = vi.fn(async () => 1);
    const resolvePendingInteraction = vi.fn(async () => true);
    const createTransientGrant = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => true),
        findPendingPermissionPromptByMember: vi.fn(async () => null),
        listPendingInteractions: vi.fn(async () => []),
        getActiveRunLease: vi
          .fn()
          .mockResolvedValueOnce(activeLease)
          .mockResolvedValueOnce(activeLease)
          .mockResolvedValueOnce(activeLease)
          .mockResolvedValueOnce(activeLease)
          .mockResolvedValueOnce(null),
        createTransientGrant,
        resolvePendingInteraction,
        releasePendingPermissionCallback,
      } as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-stale-after-settle',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-stale-after-settle',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runId: 'run:test',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          permissionCallbackClaim: claim,
        })),
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
      },
      ipcBaseDir: tempDir,
      file: 'claimed-stale-after-settle.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ permissionCallbackClaim: claim }),
    );
    expect(releasePendingPermissionCallback).not.toHaveBeenCalled();
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

  it('dispatches and resolves a single question through the live loop', async () => {
    const signing = createIpcAuthEnvelope('main_agent', 'persisted-thread');
    const claimedPath = path.join(tempDir, 'claimed-single-question.json');
    fs.writeFileSync(claimedPath, '{}');
    const persistedRequest: UserQuestionRequest = {
      requestId: 'question-live-single',
      appId: 'app:test',
      sourceAgentFolder: 'main_agent',
      targetJid: 'slack:persisted',
      threadId: 'persisted-thread',
      responseKeyId: signing.responseKeyId,
      questions: [
        {
          header: 'First',
          question: 'First question?',
          options: [{ label: 'Alpha', description: 'Choose alpha' }],
          multiSelect: false,
        },
      ],
    };
    const persisted = durableQuestionInteraction({
      request: persistedRequest,
      envelope: {
        version: 1,
        targetJid: 'slack:persisted',
        threadId: 'persisted-thread',
        request: persistedRequest,
        selections: [],
        completedQuestionIndexes: [],
      },
    });
    const resolvePendingInteraction = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async (input) => ({
          ...persisted,
          id: input.id,
        })),
        resolvePendingInteraction,
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });
    const requestUserAnswer = vi.fn(async () => ({
      requestId: persistedRequest.requestId,
      answers: { 'First question?': 'Alpha' },
      answeredBy: 'owner',
    }));

    await processUserQuestionInteractionIpc({
      request: persistedRequest,
      sourceAgentFolder: 'main_agent',
      deps: { requestUserAnswer },
      ipcBaseDir: tempDir,
      file: 'claimed-single-question.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestUserAnswer).toHaveBeenCalledOnce();
    expect(requestUserAnswer).toHaveBeenCalledWith(persistedRequest);
    expect(resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        resolution: { answers: { 'First question?': 'Alpha' } },
      }),
    );
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'main_agent',
          'user-answers',
          `${persistedRequest.requestId}.json`,
        ),
        'utf-8',
      ),
    );
    expect(response).toMatchObject({
      requestId: persistedRequest.requestId,
      answers: { 'First question?': 'Alpha' },
      answeredBy: 'owner',
    });
  });

  it('dispatches a fresh multi-question interaction once through the live loop', async () => {
    const signing = createIpcAuthEnvelope('main_agent', 'multi-thread');
    const claimedPath = path.join(tempDir, 'claimed-multi-question.json');
    fs.writeFileSync(claimedPath, '{}');
    const request: UserQuestionRequest = {
      requestId: 'question-live-multi',
      sourceAgentFolder: 'main_agent',
      threadId: 'multi-thread',
      responseKeyId: signing.responseKeyId,
      questions: [
        {
          header: 'First',
          question: 'First question?',
          options: [{ label: 'Alpha', description: '' }],
          multiSelect: false,
        },
        {
          header: 'Second',
          question: 'Second question?',
          options: [{ label: 'Beta', description: '' }],
          multiSelect: false,
        },
      ],
    };
    const pending = durableQuestionInteraction({
      request,
      envelope: {
        version: 1,
        targetJid: null,
        threadId: 'multi-thread',
        request,
        selections: [],
        completedQuestionIndexes: [],
      },
    });
    const resolvePendingInteraction = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async (input) => ({
          ...pending,
          id: input.id,
        })),
        resolvePendingInteraction,
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });
    const requestUserAnswer = vi.fn(async () => ({
      requestId: request.requestId,
      answers: {
        'First question?': 'Alpha',
        'Second question?': 'Beta',
      },
    }));

    await processUserQuestionInteractionIpc({
      request,
      sourceAgentFolder: 'main_agent',
      deps: { requestUserAnswer },
      ipcBaseDir: tempDir,
      file: 'claimed-multi-question.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestUserAnswer).toHaveBeenCalledOnce();
    expect(requestUserAnswer).toHaveBeenCalledWith(request);
    expect(resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        resolution: {
          answers: {
            'First question?': 'Alpha',
            'Second question?': 'Beta',
          },
        },
      }),
    );
  });

  it('cancels and reopens an orphaned question under the incoming active lease', async () => {
    const signing = createIpcAuthEnvelope('main_agent', 'incoming-thread');
    const claimedPath = path.join(tempDir, 'claimed-recovered-question.json');
    fs.writeFileSync(claimedPath, '{}');
    const persistedRequest: UserQuestionRequest = {
      requestId: 'question-restart-partial',
      appId: 'app:test',
      sourceAgentFolder: 'main_agent',
      runId: 'run:test',
      runLeaseToken: 'test-lease-old-token',
      runLeaseFencingVersion: 7,
      targetJid: 'slack:persisted',
      threadId: 'persisted-thread',
      responseKeyId: signing.responseKeyId,
      questions: [
        {
          header: 'First',
          question: 'First question?',
          options: [{ label: 'Alpha', description: 'Choose alpha' }],
          multiSelect: false,
        },
        {
          header: 'Second',
          question: 'Second question?',
          options: [{ label: 'Beta', description: 'Choose beta' }],
          multiSelect: false,
        },
      ],
    };
    const persistedBase = durableQuestionInteraction({
      request: persistedRequest,
      envelope: {
        version: 1,
        targetJid: 'slack:persisted',
        threadId: 'persisted-thread',
        request: persistedRequest,
        selections: [],
        completedQuestionIndexes: [0],
      },
    });
    const persisted = {
      ...persistedBase,
      runId: 'run:test',
      payload: {
        ...persistedBase.payload,
        runLeaseToken: 'test-lease-old-token',
        runLeaseFencingVersion: 7,
      },
    } satisfies PendingInteraction;
    const incomingRequest: UserQuestionRequest = {
      requestId: persistedRequest.requestId,
      appId: 'app:test',
      sourceAgentFolder: 'main_agent',
      runId: 'run:test',
      runLeaseToken: 'test-lease-new-token',
      runLeaseFencingVersion: 8,
      targetJid: 'slack:incoming',
      threadId: 'incoming-thread',
      responseKeyId: signing.responseKeyId,
      questions: [
        {
          header: 'Current',
          question: 'Incoming question?',
          options: [{ label: 'Gamma', description: 'Choose gamma' }],
          multiSelect: false,
        },
      ],
    };
    let row = persisted;
    let reopenCount = 0;
    const createPendingInteraction = vi.fn(
      async (
        input: Parameters<
          PendingInteractionRepository['createPendingInteraction']
        >[0],
      ) => {
        if (row.status === 'cancelled') {
          reopenCount += 1;
          row = {
            ...row,
            id: input.id,
            runId: input.runId ?? null,
            status: 'pending',
            payload: input.payload,
            callbackRoute: input.callbackRoute ?? null,
            resolution: null,
            approverRef: null,
            resolvedAt: null,
          };
        }
        return row;
      },
    );
    const cancelPendingQuestionInteractionIfRunLeaseInactive = vi.fn(
      async ({
        id,
        resolution,
      }: Parameters<
        PendingInteractionRepository['cancelPendingQuestionInteractionIfRunLeaseInactive']
      >[0]) => {
        if (
          row.id !== id ||
          row.status !== 'pending' ||
          row.payload.runLeaseToken !== 'test-lease-old-token' ||
          row.payload.runLeaseFencingVersion !== 7
        ) {
          return false;
        }
        row = {
          ...row,
          status: 'cancelled',
          resolution,
          resolvedAt: '2026-07-17T00:01:00.000Z',
        };
        return true;
      },
    );
    const resolvePendingInteraction = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run:test',
          jobId: null,
          workerInstanceId: 'worker-2',
          leaseToken: 'test-lease-new-token',
          fencingVersion: 8,
          status: 'active',
          claimedAt: '2026-07-17T00:01:00.000Z',
          expiresAt: '2026-07-18T00:00:00.000Z',
          heartbeatAt: '2026-07-17T00:01:00.000Z',
        })),
        createPendingInteraction,
        cancelPendingQuestionInteractionIfRunLeaseInactive,
        resolvePendingInteraction,
        createTransientGrant: vi.fn(async () => true),
      } as never,
    });
    const requestUserAnswer = vi.fn(async () => ({
      requestId: incomingRequest.requestId,
      answers: { 'Incoming question?': 'Gamma' },
      answeredBy: 'incoming-owner',
    }));

    await processUserQuestionInteractionIpc({
      request: incomingRequest,
      sourceAgentFolder: 'main_agent',
      deps: { requestUserAnswer },
      ipcBaseDir: tempDir,
      file: 'claimed-recovered-question.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(
      cancelPendingQuestionInteractionIfRunLeaseInactive,
    ).toHaveBeenCalledOnce();
    expect(createPendingInteraction).toHaveBeenCalledTimes(2);
    expect(reopenCount).toBe(1);
    expect(requestUserAnswer).toHaveBeenCalledOnce();
    expect(requestUserAnswer).toHaveBeenCalledWith(incomingRequest);
    expect(resolvePendingInteraction).toHaveBeenCalledOnce();
    expect(resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        resolution: { answers: { 'Incoming question?': 'Gamma' } },
      }),
    );
    expect(fs.existsSync(claimedPath)).toBe(false);
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'main_agent',
          'user-answers',
          `${persistedRequest.requestId}.json`,
        ),
        'utf-8',
      ),
    );
    expect(response).toMatchObject({
      requestId: incomingRequest.requestId,
      answers: { 'Incoming question?': 'Gamma' },
      answeredBy: 'incoming-owner',
    });
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
    const before = getOperationalErrorCount(
      'interaction',
      'permission_request',
    );
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(
      tempDir,
      'claimed-unresolved-permission.json',
    );
    fs.writeFileSync(claimedPath, '{}');
    const claim = {
      id: 'claim-unresolved-run',
      scope: {
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        interactionId: 'interaction-unresolved-run',
      },
    };
    const releasePendingPermissionCallback = vi.fn(async () => 1);
    const resolvePendingInteraction = vi.fn(async () => false);
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
        findPendingPermissionPromptByMember: vi.fn(async () => null),
        listPendingInteractions: vi.fn(async () => []),
        resolvePendingInteraction,
        createTransientGrant: vi.fn(async () => true),
        releasePendingPermissionCallback,
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
          permissionCallbackClaim: claim,
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
    expect(resolvePendingInteraction).toHaveBeenCalledOnce();
    expect(releasePendingPermissionCallback).not.toHaveBeenCalled();
    expect(getOperationalErrorCount('interaction', 'permission_request')).toBe(
      before + 1,
    );
    expect(fs.existsSync(claimedPath)).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'errors',
          'main_agent-claimed-unresolved-permission.json',
        ),
      ),
    ).toBe(true);
  });

  it('retries only durable resolution after a transient post-authority failure', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const file = 'retryable-resolution-permission.json';
    const claimedPath = path.join(tempDir, `.processing-test-${file}`);
    fs.writeFileSync(claimedPath, '{}');
    const claim = {
      id: 'claim-retryable-resolution',
      scope: {
        appId: 'app:test',
        sourceAgentFolder: 'main_agent',
        interactionId: 'interaction-retryable-resolution',
      },
    };
    const resolvePendingInteraction = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(true);
    const createTransientGrant = vi.fn(async () => true);
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
        findPendingPermissionPromptByMember: vi.fn(async () => null),
        listPendingInteractions: vi.fn(async () => []),
        resolvePendingInteraction,
        createTransientGrant,
      } as never,
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-retryable-resolution',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-retryable',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 7,
        jobId: 'job:test',
        targetJid: 'tg:team',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'owner',
          decisionClassification: 'user_temporary',
          permissionCallbackClaim: claim,
        })),
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
      },
      ipcBaseDir: tempDir,
      file,
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(resolvePendingInteraction).toHaveBeenCalledTimes(2);
    expect(createTransientGrant).toHaveBeenCalledOnce();
    expect(fs.existsSync(claimedPath)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, file))).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'permission-responses',
          'perm-retryable-resolution.json',
        ),
      ),
    ).toBe(true);
  });

  it('does not write scheduled question answers when durable resolution fails', async () => {
    const before = getOperationalErrorCount(
      'interaction',
      'user_question_request',
    );
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
    expect(
      getOperationalErrorCount('interaction', 'user_question_request'),
    ).toBe(before + 1);
  });

  it('withholds question IPC output when prompt persistence fails', async () => {
    const signing = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-question-persistence.json');
    fs.writeFileSync(claimedPath, '{}');
    const resolvePendingInteraction = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => true),
        resolvePendingInteraction,
      } as never,
    });
    const persistenceError = new DurableInteractionPersistenceError(
      'question prompt delivery was not persisted',
    );

    await processUserQuestionInteractionIpc({
      request: {
        requestId: 'userq-persistence-failure',
        appId: 'app:test',
        responseKeyId: signing.responseKeyId,
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        questions: [
          {
            header: 'Mode',
            question: 'Pick one',
            options: [{ label: 'Retry', description: 'Try again' }],
            multiSelect: false,
          },
        ],
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestUserAnswer: vi.fn(async () => {
          throw persistenceError;
        }),
      },
      ipcBaseDir: tempDir,
      file: 'claimed-question-persistence.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(resolvePendingInteraction).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'user-answers',
          'userq-persistence-failure.json',
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
      findPendingPermissionPromptByMember: vi.fn(async () => null),
      listPendingInteractions: vi.fn(async () => []),
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
        toolInput: { command: 'npm test' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval,
        getPermissionRuntimeSettings: promptPermissionRuntimeSettings,
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
        findPendingPermissionPromptByMember: vi.fn(async () => null),
        listPendingInteractions: vi.fn(async () => []),
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
