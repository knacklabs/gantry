import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  requestPermissionApprovalViaIpc,
  type PermissionIpcRuntimeEnv,
} from '@core/runner/permission-ipc-client.js';
import { buildPermissionIpcRuntimeEnv } from '@core/adapters/llm/deepagents-langchain/runner/runtime-env.js';
import {
  createIpcResponseSigningKeyPair,
  signIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';

let tempDir: string;

function runtimeEnv(
  overrides: Partial<PermissionIpcRuntimeEnv> = {},
): PermissionIpcRuntimeEnv {
  return {
    appId: 'default',
    agentId: 'agent:main_agent',
    chatJid: 'tg:group',
    jobId: '',
    jobName: '',
    jobRunId: '',
    jobRunLeaseToken: '',
    jobRunLeaseFencingVersion: '',
    ipcAuthToken: 'ipc-auth',
    ipcResponseVerifyKey: 'verify-key',
    ipcResponseKeyId: 'key-id',
    senderId: 'operator-1',
    senderIsControlApprover: true,
    permissionRequestTimeoutMs: 1_000,
    permissionLane: 'interactive',
    resolveWorkspaceIpcDir: (folder) => path.join(tempDir, 'ipc', folder),
    ...overrides,
  };
}

async function waitForFiles(dir: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((file) => file.endsWith('.json'))
      : [];
    if (files.length >= count) return files.sort();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

describe('requestPermissionApprovalViaIpc', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-perm-ipc-'));
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('exercise the production polling fallback');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a signed permission-request file the host can turn into a durable interaction', async () => {
    const keys = createIpcResponseSigningKeyPair();
    const decision = requestPermissionApprovalViaIpc(
      runtimeEnv({ ipcResponseVerifyKey: keys.publicKeyPem }),
      {
        agentFolder: 'main_agent',
        toolName: 'mcp__notion__search',
        toolInput: { query: 'roadmap' },
        decisionReason: 'no selected capability rule matched',
      },
    );

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const files = await waitForFiles(requestDir, 1);
    expect(files).toHaveLength(1);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, files[0]), 'utf-8'),
    ) as {
      requestId: string;
      toolName: string;
      sourceAgentFolder: string;
      senderId?: string;
      signature?: string;
      expiresAt?: string;
      authExpiresAt?: string;
      context?: { responseKeyId?: string };
      toolInput?: { query?: string };
      permissionLane?: string;
      unattended?: boolean;
    };
    // Host-required fields for durable pending_interactions creation:
    expect(request.requestId).toMatch(/^perm-/);
    expect(request.toolName).toBe('mcp__notion__search');
    expect(request.sourceAgentFolder).toBe('main_agent');
    expect(request.senderId).toBe('operator-1');
    expect(request.toolInput?.query).toBe('roadmap');
    expect(request.context?.responseKeyId).toBe('key-id');
    expect(request.permissionLane).toBe('interactive');
    expect(request.unattended).toBe(false);
    // Signed so the host can verify it came from the trusted runner.
    expect(typeof request.signature).toBe('string');
    expect(request.expiresAt).toBeUndefined();
    expect(request.authExpiresAt).toEqual(expect.any(String));

    // Resolve the request so the in-flight poll terminates cleanly.
    const responseDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-responses',
    );
    fs.mkdirSync(responseDir, { recursive: true });
    const replayedResponsePayload = {
      requestId: request.requestId,
      responseNonce: 'nonce-from-another-request',
      approved: false,
    };
    fs.writeFileSync(
      path.join(responseDir, `${request.requestId}.json`),
      JSON.stringify({
        ...replayedResponsePayload,
        signature: signIpcResponsePayload(
          keys.privateKeyPem,
          replayedResponsePayload,
        ),
      }),
    );
    const result = await decision;
    expect(result).toEqual({
      approved: false,
      reason: 'Malformed permission response',
    });
  });

  it('waits without a deadline for interactive approval at the no-timeout sentinel', async () => {
    const keys = createIpcResponseSigningKeyPair();
    const decision = requestPermissionApprovalViaIpc(
      runtimeEnv({
        permissionLane: 'interactive',
        permissionRequestTimeoutMs: 0,
        permissionMode: 'ask',
        ipcResponseVerifyKey: keys.publicKeyPem,
      }),
      {
        agentFolder: 'main_agent',
        toolName: 'mcp__notion__search',
      },
    );
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
      permissionLane?: string;
      unattended?: boolean;
    };
    expect(request).toMatchObject({
      permissionLane: 'interactive',
      unattended: false,
    });
    await expect(
      Promise.race([
        decision.then(() => 'settled'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('waiting'), 50),
        ),
      ]),
    ).resolves.toBe('waiting');

    const responsePayload = {
      requestId: request.requestId,
      responseNonce: request.responseNonce,
      approved: true,
      mode: 'allow_once',
      decidedBy: 'operator-1',
      source: 'human_once',
      repeatableForFutureRuns: false,
      reason: 'approved by operator',
      decisionClassification: 'user_temporary',
    };
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
        ...responsePayload,
        signature: signIpcResponsePayload(keys.privateKeyPem, responsePayload),
      }),
    );

    await expect(decision).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'operator-1',
      source: 'human_once',
      repeatableForFutureRuns: false,
      decisionClassification: 'user_temporary',
    });
  });

  it('marks a finite-timeout autonomous request unattended from its lane', async () => {
    const decision = requestPermissionApprovalViaIpc(
      runtimeEnv({
        permissionLane: 'autonomous',
        permissionRequestTimeoutMs: 1_000,
      }),
      {
        agentFolder: 'main_agent',
        toolName: 'mcp__notion__search',
      },
    );
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
      permissionLane?: string;
      unattended?: boolean;
    };
    expect(request).toMatchObject({
      permissionLane: 'autonomous',
      unattended: true,
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
        responseNonce: 'mismatch',
        approved: false,
        signature: 'x',
      }),
    );
    await expect(decision).resolves.toMatchObject({ approved: false });
  });

  it('honors abort while an interactive no-timeout request is waiting', async () => {
    const controller = new AbortController();
    const decision = requestPermissionApprovalViaIpc(
      runtimeEnv({
        permissionLane: 'interactive',
        permissionRequestTimeoutMs: 0,
      }),
      {
        agentFolder: 'main_agent',
        toolName: 'mcp__notion__search',
        signal: controller.signal,
      },
    );
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    expect(await waitForFiles(requestDir, 1)).toHaveLength(1);

    controller.abort();

    await expect(decision).resolves.toMatchObject({
      approved: false,
      reason: 'Permission request cancelled.',
      decisionClassification: 'user_reject',
    });
  });

  it('waits for and honors a late host allow response for zero-timeout auto mode', async () => {
    const keys = createIpcResponseSigningKeyPair();
    const decision = requestPermissionApprovalViaIpc(
      runtimeEnv({
        jobId: 'job-auto',
        jobRunId: 'run-auto',
        permissionLane: 'autonomous',
        permissionRequestTimeoutMs: 0,
        permissionMode: 'auto',
        turnIntentSummary: 'Read the CRM record.',
        ipcResponseVerifyKey: keys.publicKeyPem,
      }),
      {
        agentFolder: 'main_agent',
        toolName: 'mcp__crm__read',
      },
    );
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
      turnIntentSummary: 'Read the CRM record.',
    });
    const responsePayload = {
      requestId: request.requestId,
      responseNonce: request.responseNonce,
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
      repeatableForFutureRuns: true,
      reason: 'allowed once',
      risk_level: 'high',
      risk_category: 'network',
      decisionClassification: 'user_temporary',
    };
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
        ...responsePayload,
        signature: signIpcResponsePayload(keys.privateKeyPem, responsePayload),
      }),
    );

    await expect(decision).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
      repeatableForFutureRuns: true,
      risk_level: 'high',
      risk_category: 'network',
      decisionClassification: 'user_temporary',
    });
  });
});

describe('buildPermissionIpcRuntimeEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the permission lane from GANTRY_PERMISSION_LANE instead of a job id', () => {
    vi.stubEnv('GANTRY_JOB_ID', 'job-1');
    vi.stubEnv('GANTRY_PERMISSION_LANE', 'interactive');
    expect(buildPermissionIpcRuntimeEnv().permissionLane).toBe('interactive');

    vi.stubEnv('GANTRY_JOB_ID', '');
    vi.stubEnv('GANTRY_PERMISSION_LANE', '');
    expect(buildPermissionIpcRuntimeEnv().permissionLane).toBe('autonomous');
  });
});
