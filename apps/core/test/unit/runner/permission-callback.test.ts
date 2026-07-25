import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '@core/infrastructure/ipc/request-signing.js';
import { verifyIpcResponsePayload } from '@core/infrastructure/ipc/response-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';
import { formatPermissionDeniedMessage } from '@core/shared/permission-decision-message.js';

const CANCELLATION_LIFETIME_MS = 24 * 60 * 60_000;

vi.mock('@core/shared/ipc-signing.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/shared/ipc-signing.js')
  >('@core/shared/ipc-signing.js');
  return {
    ...actual,
    hasValidIpcResponseSignature: vi.fn(() => true),
  };
});

async function waitForFiles(dir: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((file) => file.endsWith('.json'))
      : [];
    if (files.length >= count) return files.sort();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .sort()
    : [];
}

describe('requestPermissionApproval', () => {
  let tempDir: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    oldEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-permission-'));
    process.env.GANTRY_WORKSPACE_GROUP_DIR = path.join(tempDir, 'workspace');
    process.env.GANTRY_WORKSPACE_EXTRA_DIR = path.join(tempDir, 'extra');
    process.env.GANTRY_IPC_DIR = path.join(tempDir, 'ipc');
    process.env.GANTRY_IPC_INPUT_DIR = path.join(tempDir, 'input');
    process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = 'test-key';
    process.env.GANTRY_IPC_RESPONSE_KEY_ID = 'test-response-key';
    process.env.GANTRY_AGENT_RUN_HANDLE = 'run-handle-1';
    process.env.GANTRY_MEMORY_USER_ID = 'operator-1';
    process.env.GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER = '1';
    process.env.GANTRY_PERMISSION_LANE = 'interactive';
  });

  afterEach(() => {
    process.env = oldEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not reuse a denial for a different requested tool in the same run', async () => {
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const first = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'find ~/persona -type f' },
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const firstRequestFiles = await waitForFiles(requestDir, 1);
    expect(firstRequestFiles).toHaveLength(1);
    const firstRequest = JSON.parse(
      fs.readFileSync(path.join(requestDir, firstRequestFiles[0]), 'utf-8'),
    ) as {
      requestId: string;
      responseNonce: string;
      payload?: { toolName?: string };
      toolName?: string;
    };

    const responseDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-responses',
    );
    fs.mkdirSync(responseDir, { recursive: true });
    fs.writeFileSync(
      path.join(responseDir, `${firstRequest.requestId}.json`),
      JSON.stringify({
        requestId: firstRequest.requestId,
        responseNonce: firstRequest.responseNonce,
        approved: false,
        mode: 'cancel',
        decidedBy: 'Ravi',
        reason: 'denied bash',
        signature: 'test-signature',
      }),
    );

    const firstDecision = await first;
    expect(firstDecision).toMatchObject({
      approved: false,
      decidedBy: 'Ravi',
    });

    const second = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Browser',
      toolInput: { url: 'https://example.com' },
    });
    const secondRequestFiles = await waitForFiles(requestDir, 2);
    expect(secondRequestFiles).toHaveLength(2);
    const secondRequestFile = secondRequestFiles.find(
      (file) => file !== firstRequestFiles[0],
    );
    expect(secondRequestFile).toBeDefined();
    const secondRequest = JSON.parse(
      fs.readFileSync(path.join(requestDir, secondRequestFile!), 'utf-8'),
    ) as {
      requestId: string;
      responseNonce: string;
      payload?: { toolName?: string };
      toolName?: string;
    };
    expect(secondRequest.payload?.toolName ?? secondRequest.toolName).toBe(
      'Browser',
    );
    fs.writeFileSync(
      path.join(responseDir, `${secondRequest.requestId}.json`),
      JSON.stringify({
        requestId: secondRequest.requestId,
        responseNonce: secondRequest.responseNonce,
        approved: true,
        mode: 'allow_once',
        decidedBy: 'Ravi',
        reason: 'approved',
        signature: 'test-signature',
      }),
    );

    const secondDecision = await second;
    expect(secondDecision.approved).toBe(true);
    expect(secondDecision.mode).toBe('allow_once');
  });

  it('still immediately denies zero-timeout ask mode', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'autonomous';
    process.env.GANTRY_JOB_ID = 'job-ask';
    process.env.GANTRY_JOB_RUN_ID = 'run-ask';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '0';
    process.env.GANTRY_PERMISSION_MODE = 'ask';
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const result = await requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
    });

    expect(result).toMatchObject({
      approved: false,
      decidedBy: 'runtime',
      reason:
        'Permission request was sent to the host. Unattended jobs do not wait for approval during the active tool call; approve the requested capability before retrying the scheduled run.',
      decisionClassification: 'user_reject',
    });
    expect(formatPermissionDeniedMessage(result, result.reason!)).toBe(
      'Permission denied (decided by: runtime): Permission request was sent to the host. Unattended jobs do not wait for approval during the active tool call; approve the requested capability before retrying the scheduled run.',
    );
  });

  it('immediately denies a zero-timeout autonomous run without a job id', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'autonomous';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '0';
    process.env.GANTRY_PERMISSION_MODE = 'ask';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    await expect(
      requestPermissionApproval({
        appId: 'default',
        agentId: 'agent:main_agent',
        workspaceFolder: 'main_agent',
        targetJid: 'tg:test',
        toolName: 'Bash',
        toolInput: { command: 'git status --short' },
      }),
    ).resolves.toMatchObject({
      approved: false,
      reason:
        'Permission request was sent to the host. Autonomous runs do not wait for approval during the active tool call; approve the requested capability before retrying the run.',
      decisionClassification: 'user_reject',
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as { unattended?: boolean; permissionLane?: string };
    expect(request).toMatchObject({
      unattended: true,
      permissionLane: 'autonomous',
    });
  });

  it('returns timeout guidance when a finite autonomous timeout elapses', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'autonomous';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '10000';
    process.env.GANTRY_PERMISSION_MODE = 'ask';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const requestedAt = Date.now();
    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as {
      unattended?: boolean;
      permissionLane?: string;
      expiresAt?: string;
      authExpiresAt?: string;
    };
    expect(request).toMatchObject({
      unattended: false,
      permissionLane: 'autonomous',
    });
    expect(Date.parse(request.expiresAt!)).toBeGreaterThanOrEqual(
      requestedAt + 10_000,
    );
    expect(Date.parse(request.expiresAt!)).toBeLessThanOrEqual(
      Date.now() + 10_000,
    );
    expect(request.authExpiresAt).toEqual(expect.any(String));

    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 60_000);
    const result = await decision;

    expect(result).toMatchObject({
      approved: false,
      decidedBy: 'runtime',
      reason:
        'Timed out waiting for approval. Retry the autonomous run when an approver is available.',
      decisionClassification: 'user_reject',
    });
    expect(formatPermissionDeniedMessage(result, result.reason!)).toBe(
      'Permission denied (decided by: runtime): Timed out waiting for approval. Retry the autonomous run when an approver is available.',
    );
    expect(result.reason).not.toContain('do not wait for approval');
    dateNow.mockRestore();
  });

  it('returns interactive guidance when a finite interactive timeout elapses', async () => {
    process.env.GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS = '10000';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as { permissionLane?: string };
    expect(request.permissionLane).toBe('interactive');
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 60_000);

    const result = await decision;
    expect(result).toMatchObject({
      approved: false,
      decidedBy: 'runtime',
      reason:
        'Timed out waiting for interactive approval. Retry the live request when an approver is available.',
      decisionClassification: 'user_reject',
    });
    expect(result.reason).not.toContain('scheduled run');
    dateNow.mockRestore();
  });

  it('cancels an unbounded interactive wait without leaving a pending request or polling', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'interactive';
    process.env.GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS = '0';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const controller = new AbortController();

    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
      signal: controller.signal,
    });
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const requestPath = path.join(requestDir, requestFile);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as {
      requestId: string;
    };
    const responsePath = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-responses',
      `${request.requestId}.json`,
    );
    const originalExistsSync = fs.existsSync.bind(fs);
    const existsSync = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation(originalExistsSync);

    controller.abort();
    const result = await new Promise<Awaited<typeof decision>>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Permission cancellation did not settle')),
          500,
        );
        void decision.then(
          (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      },
    );

    expect(result).toEqual({
      approved: false,
      decidedBy: 'runtime',
      reason: 'Permission request cancelled.',
      decisionClassification: 'user_reject',
    });
    expect(fs.existsSync(requestPath)).toBe(false);
    expect(
      fs.existsSync(
        path.join(tempDir, 'ipc', 'main_agent', 'permission-cancellations'),
      ),
    ).toBe(false);
    const responsePollsAfterCancellation = existsSync.mock.calls.filter(
      ([candidate]) => candidate === responsePath,
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      existsSync.mock.calls.filter(([candidate]) => candidate === responsePath),
    ).toHaveLength(responsePollsAfterCancellation);
  });

  it('signals the host when an interactive request was claimed before cancellation', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'interactive';
    process.env.GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS = '0';
    process.env.GANTRY_IPC_AUTH_TOKEN = 'permission-cancellation-test-token';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const controller = new AbortController();

    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
      signal: controller.signal,
    });
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const requestPath = path.join(requestDir, requestFile);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as {
      requestId: string;
    };
    const claimedPath = path.join(
      requestDir,
      `.processing-host-${requestFile}`,
    );
    fs.renameSync(requestPath, claimedPath);

    controller.abort();

    await expect(decision).resolves.toMatchObject({
      approved: false,
      decidedBy: 'runtime',
      reason: 'Permission request cancelled.',
    });
    const cancellationDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-cancellations',
    );
    const [cancellationFile] = await waitForFiles(cancellationDir, 1);
    const cancellation = JSON.parse(
      fs.readFileSync(path.join(cancellationDir, cancellationFile), 'utf-8'),
    ) as {
      authExpiresAt?: string;
      expiresAt?: string;
      requestId?: string;
      permissionRequestId?: string;
      sourceAgentFolder?: string;
      reason?: string;
      signature?: string;
      [key: string]: unknown;
    };
    expect(cancellation).toMatchObject({
      permissionRequestId: request.requestId,
      sourceAgentFolder: 'main_agent',
      reason: 'Permission request cancelled.',
    });
    expect(cancellation.requestId).toMatch(/^perm-cancel-/);
    expect(cancellation).not.toHaveProperty('expiresAt');
    expect(
      Date.parse(String(cancellation.authExpiresAt)) - Date.now(),
    ).toBeGreaterThanOrEqual(CANCELLATION_LIFETIME_MS - 100);
    const { signature, ...payload } = cancellation;
    expect(
      verifyIpcRequestPayload(
        'permission-cancellation-test-token',
        payload,
        signature,
      ),
    ).toBe(true);
    expect(
      validateIpcRequestFreshness(
        payload,
        Date.now(),
        CANCELLATION_LIFETIME_MS,
      ),
    ).toEqual({ ok: true });
  });

  it('waits indefinitely for an interactive response at the no-timeout sentinel', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'interactive';
    process.env.GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS = '0';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    let settled = false;
    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
    });
    void decision.then(() => {
      settled = true;
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as {
      requestId: string;
      responseNonce: string;
      unattended?: boolean;
      permissionLane?: string;
      expiresAt?: string;
      authExpiresAt?: string;
    };
    expect(request).toMatchObject({
      unattended: false,
      permissionLane: 'interactive',
    });
    expect(request.expiresAt).toBeUndefined();
    expect(request.authExpiresAt).toEqual(expect.any(String));

    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    dateNow.mockRestore();

    const responseDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-responses',
    );
    fs.mkdirSync(responseDir, { recursive: true });
    fs.writeFileSync(
      path.join(responseDir, `${request.requestId}.json`),
      JSON.stringify({
        requestId: request.requestId,
        responseNonce: request.responseNonce,
        approved: true,
        mode: 'allow_once',
        decidedBy: 'Ravi',
        reason: 'approved',
        signature: 'test-signature',
      }),
    );

    await expect(decision).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'Ravi',
    });
  });

  it('serializes the authenticated host-injected command prefix', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'autonomous';
    process.env.GANTRY_JOB_ID = 'job-prefix';
    process.env.GANTRY_JOB_RUN_ID = 'run-prefix';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '0';
    process.env.GANTRY_PERMISSION_MODE = 'ask';
    process.env.GANTRY_IPC_AUTH_TOKEN = 'signed-prefix-test-token';
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const hostInjectedCommandPrefix =
      "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18790/'";

    await requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      hostInjectedCommandPrefix,
      toolInput: {
        command: `${hostInjectedCommandPrefix} git status --short`,
      },
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as {
      hostInjectedCommandPrefix?: string;
      signature?: string;
    };
    expect(request.hostInjectedCommandPrefix).toBe(hostInjectedCommandPrefix);
    expect(request.signature).toEqual(expect.any(String));
  });

  it('waits for and honors a late host allow response for zero-timeout auto mode', async () => {
    process.env.GANTRY_PERMISSION_LANE = 'autonomous';
    process.env.GANTRY_JOB_ID = 'job-auto';
    process.env.GANTRY_JOB_RUN_ID = 'run-auto';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '0';
    process.env.GANTRY_PERMISSION_MODE = 'auto';
    process.env.GANTRY_TURN_INTENT_SUMMARY = 'Inspect the repository status.';
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
    });
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as {
      requestId: string;
      responseNonce: string;
      unattended?: boolean;
      turnIntentSummary?: string;
    };
    expect(request).toMatchObject({
      unattended: true,
      turnIntentSummary: 'Inspect the repository status.',
    });
    const responseDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-responses',
    );
    fs.mkdirSync(responseDir, { recursive: true });
    fs.writeFileSync(
      path.join(responseDir, `${request.requestId}.json`),
      JSON.stringify({
        requestId: request.requestId,
        responseNonce: request.responseNonce,
        approved: true,
        mode: 'allow_once',
        decidedBy: 'auto_classifier',
        reason: 'allowed once',
        decisionClassification: 'user_temporary',
        signature: 'test-signature',
      }),
    );

    await expect(decision).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
      decisionClassification: 'user_temporary',
    });
  });

  it('preserves host risk through the signed IPC response to the runner decision', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    process.env.GANTRY_IPC_AUTH_TOKEN = envelope.authToken;
    process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = envelope.responseVerifyKey;
    process.env.GANTRY_IPC_RESPONSE_KEY_ID = envelope.responseKeyId;
    process.env.GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS = '0';
    delete process.env.GANTRY_JOB_ID;
    delete process.env.GANTRY_JOB_RUN_ID;
    vi.resetModules();
    const { hasValidIpcResponseSignature } =
      await import('@core/shared/ipc-signing.js');
    vi.mocked(hasValidIpcResponseSignature).mockClear();
    vi.mocked(hasValidIpcResponseSignature).mockImplementationOnce(
      (publicKey, raw, payload) =>
        verifyIpcResponsePayload(
          publicKey,
          payload,
          typeof raw.signature === 'string' ? raw.signature : undefined,
        ),
    );
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const runnerDecision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      workspaceFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf ./generated' },
    });
    const ipcBaseDir = path.join(tempDir, 'ipc');
    const requestDir = path.join(
      ipcBaseDir,
      'main_agent',
      'permission-requests',
    );
    const [requestFile] = await waitForFiles(requestDir, 1);
    const rawRequest = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf-8'),
    ) as Record<string, unknown>;
    const context = rawRequest.context as Record<string, unknown>;
    const claimedPath = path.join(tempDir, 'claimed-risk-response.json');
    fs.writeFileSync(claimedPath, '{}');
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'critical' as const,
      risk_category: 'destructive' as const,
      reason: 'Deleting generated files has irreversible effects.',
      latencyMs: 1,
    }));
    const requestPermissionApprovalOnHost = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
      reason: 'operator denied',
      decisionClassification: 'user_reject' as const,
    }));

    await processPermissionInteractionIpc({
      request: {
        requestId: rawRequest.requestId,
        appId: rawRequest.appId,
        agentId: rawRequest.agentId,
        responseNonce: rawRequest.responseNonce,
        responseKeyId: context.responseKeyId,
        sourceAgentFolder: rawRequest.sourceAgentFolder,
        targetJid: rawRequest.targetJid,
        toolName: rawRequest.toolName,
        toolInput: rawRequest.toolInput,
        classifierToolInput: rawRequest.toolInput,
      } as never,
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({
          'tg:test': {
            folder: 'main_agent',
            agentConfig: { permissionMode: 'auto' },
            conversationKind: 'dm',
          },
        }),
        requestPermissionApproval: requestPermissionApprovalOnHost,
        classifierConsult,
        publishRuntimeEvent: vi.fn(async () => undefined),
        getPermissionRuntimeSettings: () => ({
          agents: {},
          permissions: { autoMode: {}, trustedRoots: [] },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
      ipcBaseDir,
      file: requestFile,
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    await expect(runnerDecision).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'human',
      reason: 'operator denied',
      risk_level: 'critical',
      risk_category: 'destructive',
    });
    expect(classifierConsult).toHaveBeenCalledOnce();
    expect(requestPermissionApprovalOnHost).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionReason: 'Deleting generated files has irreversible effects.',
        risk_level: 'critical',
        risk_category: 'destructive',
      }),
    );
    expect(hasValidIpcResponseSignature).toHaveBeenCalledOnce();
  });
});
