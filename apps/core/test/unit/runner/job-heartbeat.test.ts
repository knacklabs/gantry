import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRunnerInput,
  AgentRunnerOutput,
} from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';

vi.mock('@core/shared/ipc-signing.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/shared/ipc-signing.js')
  >('@core/shared/ipc-signing.js');
  return {
    ...actual,
    hasValidIpcResponseSignature: vi.fn(() => true),
  };
});

const SCHEDULED_INPUT: AgentRunnerInput = {
  prompt: 'do the thing',
  appId: 'default',
  agentId: 'agent-1',
  workspaceFolder: 'agent_folder',
  chatJid: 'chat:1',
  isScheduledJob: true,
  jobId: 'job-1',
  runId: 'run-1',
  permissionMode: 'ask',
};

describe('startJobHeartbeat', () => {
  let tempDir: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    oldEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-heartbeat-'));
    process.env.GANTRY_WORKSPACE_GROUP_DIR = path.join(tempDir, 'workspace');
    process.env.GANTRY_WORKSPACE_EXTRA_DIR = path.join(tempDir, 'extra');
    process.env.GANTRY_IPC_DIR = path.join(tempDir, 'ipc');
    process.env.GANTRY_IPC_INPUT_DIR = path.join(tempDir, 'input');
    process.env.GANTRY_PERMISSION_LANE = 'autonomous';
    process.env.GANTRY_JOB_ID = 'job-1';
    process.env.GANTRY_JOB_RUN_ID = 'run-1';
    process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = oldEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports an in-flight permission wait until its response arrives', async () => {
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const { startJobHeartbeat } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/job-heartbeat.js');
    const outputs: AgentRunnerOutput[] = [];
    const heartbeat = startJobHeartbeat({
      agentInput: SCHEDULED_INPUT,
      writeOutput: (output) => outputs.push(output),
      getSessionId: () => undefined,
    });

    const decision = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent-1',
      workspaceFolder: 'agent_folder',
      targetJid: 'chat:1',
      toolName: 'RunCommand',
    });
    const requestDir = path.join(
      tempDir,
      'ipc',
      'agent_folder',
      'permission-requests',
    );
    const [requestFile] = fs.readdirSync(requestDir);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile!), 'utf8'),
    ) as { requestId: string; responseNonce: string };
    fs.unlinkSync(path.join(requestDir, requestFile!));

    vi.advanceTimersByTime(15_000);
    expect(outputs[0]?.runtimeEvents?.[0]?.payload).toMatchObject({
      pendingPermissionRequests: 1,
      pendingPermissionToolNames: ['RunCommand'],
    });

    const responseDir = path.join(
      tempDir,
      'ipc',
      'agent_folder',
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
        signature: 'test-signature',
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(decision).resolves.toMatchObject({ approved: true });

    heartbeat.stop();
    expect(outputs.at(-1)?.runtimeEvents?.[0]?.payload).toMatchObject({
      pendingPermissionRequests: 0,
      pendingPermissionToolNames: [],
    });
  });
});
