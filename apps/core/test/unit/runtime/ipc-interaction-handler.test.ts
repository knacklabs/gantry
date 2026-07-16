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
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

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
          { kind: 'mcp_tool', mcpTool: GITHUB_REPOS_LIST_TOOL_NAME },
        ],
      }),
    }),
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
      decision: 'allow' as const,
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

    expect(classifierConsult).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalToolName: GITHUB_REPOS_LIST_TOOL_NAME,
        turnIntentSummary: 'Inspect the current worktree.',
        approvedCapabilityIds: [GITHUB_REPOS_READ_CAPABILITY_ID],
      }),
    );
    expect(classifierConsult.mock.calls[0]?.[0].toolInput).toEqual({
      owner: 'cawstudios',
    });
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
      decidedBy: 'auto_classifier',
      decisionClassification: 'user_temporary',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.classifier_decision',
        payload: expect.objectContaining({
          decision: 'allow',
          intentSource: 'runner_summary',
        }),
      }),
    );
    const classifierEvent = publishRuntimeEvent.mock.calls.find(
      ([event]) => event.eventType === 'permission.classifier_decision',
    )?.[0];
    expect(classifierEvent?.payload).not.toHaveProperty('suggestionKey');
  });

  it('honors a conversation override on the live agent-qualified route key', async () => {
    const classifierConsult = vi.fn(async () => ({
      decision: 'allow' as const,
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

    expect(classifierConsult).toHaveBeenCalledOnce();
    expect(classifierConsult.mock.calls[0]?.[0].toolInput).toEqual({
      owner: 'cawstudios',
    });
    expect(classifierConsult.mock.calls[0]?.[0].turnIntentSummary).toBe(
      'Inspect the worktree.',
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        // Non-authoritative event metadata from the request itself.
        runId: 'run:runner-supplied',
        payload: expect.objectContaining({ intentSource: 'runner_summary' }),
      }),
    );
    expect(publishRuntimeEvent.mock.calls[0]?.[0].payload).not.toHaveProperty(
      'suggestionKey',
    );
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
    });
  });

  it('consults for an unattended job without requester gating', async () => {
    const classifierConsult = vi.fn(async () => ({
      decision: 'allow' as const,
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
                { kind: 'mcp_tool', mcpTool: 'mcp__crm__read' },
              ],
            }),
          }),
        }),
      } as never,
    });

    expect(classifierConsult).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIntentSummary: '',
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ intentSource: 'none' }),
      }),
    );
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
    });
  });

  it('denies an unattended gray-zone mutation without consulting or prompting', async () => {
    const classifierConsult = vi.fn();
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

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'runtime',
      reason: expect.stringContaining('Classifier requested human approval'),
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.classifier_decision',
        payload: expect.objectContaining({ decision: 'ask' }),
      }),
    );
  });

  it('denies an unattended read-only command matched by the YOLO denylist backstop', async () => {
    const classifierConsult = vi.fn(async () => ({
      decision: 'allow' as const,
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
      decidedBy: 'runtime',
      reason: expect.stringContaining('YOLO-mode denylist backstop'),
    });
  });

  it('adds the repeated allow hint to an IPC ask prompt', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'owner',
    }));
    const counter = {
      appId: 'app:test',
      agentFolder: 'main_agent',
      suggestionKey: 'main_agent|RunCommand(git status)',
      allowCount: 3,
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
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ promotionHintCount: 3 }),
    );
  });

  it('publishes an input-truncated ask before preserving the IPC prompt flow', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-auto-ask.json');
    fs.writeFileSync(claimedPath, '{}');
    const classifierConsult = vi.fn(async () => ({
      decision: 'allow' as const,
      reason: 'Would allow if consulted.',
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
        toolName: 'mcp__crm__read',
        toolInput: { id: 'crm-1', environment: { HTTP_PROXY: '[truncated]' } },
        toolInputSanitized: true,
        toolInputSanitizedPaths: ['environment.HTTP_PROXY'],
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

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestions: undefined,
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.classifier_decision',
        payload: expect.objectContaining({
          decision: 'ask',
          failureCode: 'input_truncated',
        }),
      }),
    );
  });

  it('turns unattended sanitized auto input into an immediate IPC denial', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const claimedPath = path.join(tempDir, 'claimed-unattended-ask.json');
    fs.writeFileSync(claimedPath, '{}');
    const classifierConsult = vi.fn(async () => ({
      decision: 'allow' as const,
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
        toolInput: { command: `${'x'.repeat(500)}...[truncated]` },
        toolInputSanitized: true,
        toolInputSanitizedPaths: ['command'],
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
      reason: expect.stringContaining('input was sanitized'),
      decisionClassification: 'user_reject',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.classifier_decision',
        payload: expect.objectContaining({ failureCode: 'input_truncated' }),
      }),
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
            permissions: { autoMode: {} },
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
