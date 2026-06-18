import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  requestPermissionApprovalViaIpc,
  type PermissionIpcRuntimeEnv,
} from '@core/runner/permission-ipc-client.js';

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
    permissionRequestTimeoutMs: 1_000,
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
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a signed permission-request file the host can turn into a durable interaction', async () => {
    const decision = requestPermissionApprovalViaIpc(runtimeEnv(), {
      agentFolder: 'main_agent',
      toolName: 'mcp__notion__search',
      toolInput: { query: 'roadmap' },
      decisionReason: 'no selected capability rule matched',
    });

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
      signature?: string;
      context?: { responseKeyId?: string };
      toolInput?: { query?: string };
    };
    // Host-required fields for durable pending_interactions creation:
    expect(request.requestId).toMatch(/^perm-/);
    expect(request.toolName).toBe('mcp__notion__search');
    expect(request.sourceAgentFolder).toBe('main_agent');
    expect(request.toolInput?.query).toBe('roadmap');
    expect(request.context?.responseKeyId).toBe('key-id');
    // Signed so the host can verify it came from the trusted runner.
    expect(typeof request.signature).toBe('string');

    // Resolve the request so the in-flight poll terminates cleanly.
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
    const result = await decision;
    // Nonce mismatch -> rejected response (the signature/nonce path is enforced).
    expect(result.approved).toBe(false);
  });

  it('does not wait for approval for unattended jobs (zero/negative timeout)', async () => {
    const result = await requestPermissionApprovalViaIpc(
      runtimeEnv({
        jobId: 'job-1',
        jobRunId: 'run-1',
        permissionRequestTimeoutMs: 0,
      }),
      {
        agentFolder: 'main_agent',
        toolName: 'mcp__notion__search',
      },
    );
    expect(result.approved).toBe(false);
    expect(result.decisionClassification).toBe('user_reject');
    // The request file is still written so the host records the durable row and
    // surfaces the capability blocker.
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
    ) as { jobId?: string; runId?: string };
    expect(request.jobId).toBe('job-1');
    expect(request.runId).toBe('run-1');
  });
});
