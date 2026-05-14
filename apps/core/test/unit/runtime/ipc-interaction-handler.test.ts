import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';

import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from '@core/runtime/ipc-interaction-handler.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('ipc-interaction-handler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-interaction-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
        id: 'tool:mcp__myclaw__service_restart',
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
        toolName: 'mcp__myclaw__service_restart',
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
              rules: [{ toolName: 'mcp__myclaw__service_restart' }],
            },
          ],
        })),
        sendMessage,
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
    ).toEqual(['mcp__myclaw__service_restart']);
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['mcp__myclaw__service_restart'],
      { appId: 'app:test' },
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      expect.stringContaining('Persistent permission applied:'),
      expect.any(Object),
    );
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
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
