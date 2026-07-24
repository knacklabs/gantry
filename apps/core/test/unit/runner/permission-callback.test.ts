import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(firstDecision.approved).toBe(false);

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
    process.env.GANTRY_JOB_ID = 'job-ask';
    process.env.GANTRY_JOB_RUN_ID = 'run-ask';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '0';
    process.env.GANTRY_PERMISSION_MODE = 'ask';
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
        'Permission request was sent to the host. Unattended jobs do not wait for approval during the active tool call; approve the requested capability before retrying the scheduled run.',
      decisionClassification: 'user_reject',
    });
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
    await waitForFiles(requestDir, 1);
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 60_000);

    const result = await decision;
    expect(result).toMatchObject({
      approved: false,
      reason:
        'Timed out waiting for interactive approval. Retry the live request when an approver is available.',
      decisionClassification: 'user_reject',
    });
    expect(result.reason).not.toContain('scheduled run');
    dateNow.mockRestore();
  });

  it('waits indefinitely for an interactive response at the no-timeout sentinel', async () => {
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
    };
    expect(request.unattended).toBe(false);

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
});
