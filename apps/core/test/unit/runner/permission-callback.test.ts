import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/runner/ipc-signing.js',
  async () => {
    const actual = await vi.importActual<
      typeof import('@core/adapters/llm/anthropic-claude-agent/runner/ipc-signing.js')
    >('@core/adapters/llm/anthropic-claude-agent/runner/ipc-signing.js');
    return {
      ...actual,
      hasValidIpcResponseSignature: vi.fn(() => true),
    };
  },
);

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
      decisionClassification: 'user_reject',
    });
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
