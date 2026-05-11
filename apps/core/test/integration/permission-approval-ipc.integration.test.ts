import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

type PendingPermissionRequest = {
  filePath: string;
  requestId: string;
  raw: Record<string, unknown>;
};

async function waitForPermissionRequest(
  requestsDir: string,
  timeoutMs = 5_000,
): Promise<PendingPermissionRequest> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const requestFile = fs
      .readdirSync(requestsDir)
      .find((entry) => entry.endsWith('.json'));
    if (requestFile) {
      const filePath = path.join(requestsDir, requestFile);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const requestId =
        typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
      if (requestId) {
        return { filePath, requestId, raw };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for permission request file');
}

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-perm-ipc-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.stubEnv('MYCLAW_IPC_AUTH_SECRET', 'perm-ipc-secret');
  vi.resetModules();
  const { clearConsumedIpcRequestIds } =
    await import('@core/runtime/ipc-auth-validation.js');
  clearConsumedIpcRequestIds();
  vi.unstubAllEnvs();
});

describe('permission approval IPC boundary', () => {
  it('accepts a signed approval response and enforces request replay protection', async () => {
    const tempRoot = makeTempRoot();
    const groupFolder = 'team-main';
    const threadId = 'thread-7';
    const groupIpcDir = path.join(tempRoot, 'ipc', groupFolder);
    const permissionRequestsDir = path.join(groupIpcDir, 'permission-requests');
    const permissionResponsesDir = path.join(
      groupIpcDir,
      'permission-responses',
    );
    fs.mkdirSync(permissionRequestsDir, { recursive: true });
    fs.mkdirSync(permissionResponsesDir, { recursive: true });

    vi.stubEnv('MYCLAW_IPC_AUTH_SECRET', 'perm-ipc-secret');
    vi.stubEnv('MYCLAW_WORKSPACE_GROUP_DIR', path.join(tempRoot, 'workspace'));
    vi.stubEnv('MYCLAW_WORKSPACE_EXTRA_DIR', path.join(tempRoot, 'extra'));
    vi.stubEnv('MYCLAW_IPC_DIR', path.join(tempRoot, 'ipc'));
    vi.stubEnv('MYCLAW_IPC_INPUT_DIR', path.join(groupIpcDir, 'input'));

    vi.resetModules();
    const { createIpcAuthEnvelope, getIpcResponseSigningPrivateKey } =
      await import('@core/runtime/ipc-auth.js');
    const envelope = createIpcAuthEnvelope(groupFolder, threadId, {
      appId: 'app:team',
      agentId: 'agent:team-main',
    });
    const responseSigningKey = getIpcResponseSigningPrivateKey(
      groupFolder,
      threadId,
      envelope.responseKeyId,
    );
    expect(responseSigningKey).toBeTruthy();

    vi.stubEnv('MYCLAW_IPC_AUTH_TOKEN', envelope.authToken);
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', envelope.responseVerifyKey);
    vi.stubEnv('MYCLAW_IPC_RESPONSE_KEY_ID', envelope.responseKeyId);
    vi.stubEnv('MYCLAW_PERMISSION_TIMEOUT_MS', '10000');

    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/runner/claude/permission-callback.js');
    const { parsePermissionIpcRequest } =
      await import('@core/runtime/ipc-parsing.js');
    const { writePermissionIpcResponse } =
      await import('@core/runtime/ipc-interaction-handler.js');

    const pendingDecision = requestPermissionApproval({
      appId: 'app:team',
      agentId: 'agent:team-main',
      groupFolder,
      threadId,
      toolName: 'WebFetch',
      title: 'Fetch internal dashboard',
      decisionReason: 'Needs navigation to complete the task',
      toolInput: {
        url: 'https://example.internal/dashboard',
        apiKey: 'sk-sensitive-key',
        nested: { password: 'top-secret' },
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [
            {
              toolName: 'WebFetch',
              ruleContent: 'domain:example.internal',
              secretToken: 'must-not-survive',
            },
          ],
          ignored: { nested: { value: 'must-not-survive' } },
        },
      ],
    });

    const pendingRequest = await waitForPermissionRequest(
      permissionRequestsDir,
    );
    const parsedRequest = parsePermissionIpcRequest(
      pendingRequest.raw,
      groupFolder,
    );

    expect(parsedRequest).toMatchObject({
      requestId: pendingRequest.requestId,
      appId: 'app:team',
      agentId: 'agent:team-main',
      responseNonce: expect.any(String),
      sourceAgentFolder: groupFolder,
      threadId,
      toolName: 'WebFetch',
      toolInput: {
        url: 'https://example.internal/dashboard',
        apiKey: '[REDACTED]',
        nested: {
          password: '[REDACTED]',
        },
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [
            {
              toolName: 'WebFetch',
              ruleContent: 'domain:example.internal',
            },
          ],
        },
      ],
    });
    expect(() =>
      parsePermissionIpcRequest(pendingRequest.raw, groupFolder),
    ).toThrow(/replay/);

    writePermissionIpcResponse(
      path.join(tempRoot, 'ipc'),
      groupFolder,
      {
        requestId: pendingRequest.requestId,
        responseNonce: parsedRequest.responseNonce,
        approved: true,
        mode: 'allow_once',
        decidedBy: 'admin:lead',
        reason: 'Approved for one-time access',
        decisionClassification: 'user_temporary',
      },
      responseSigningKey,
    );

    await expect(pendingDecision).resolves.toEqual({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'admin:lead',
      reason: 'Approved for one-time access',
      decisionClassification: 'user_temporary',
    });
  });

  it('fails closed when response signature is missing', async () => {
    const tempRoot = makeTempRoot();
    const groupFolder = 'team-main';
    const groupIpcDir = path.join(tempRoot, 'ipc', groupFolder);
    const permissionRequestsDir = path.join(groupIpcDir, 'permission-requests');
    const permissionResponsesDir = path.join(
      groupIpcDir,
      'permission-responses',
    );
    fs.mkdirSync(permissionRequestsDir, { recursive: true });
    fs.mkdirSync(permissionResponsesDir, { recursive: true });

    vi.stubEnv('MYCLAW_IPC_AUTH_SECRET', 'perm-ipc-secret');
    vi.stubEnv('MYCLAW_WORKSPACE_GROUP_DIR', path.join(tempRoot, 'workspace'));
    vi.stubEnv('MYCLAW_WORKSPACE_EXTRA_DIR', path.join(tempRoot, 'extra'));
    vi.stubEnv('MYCLAW_IPC_DIR', path.join(tempRoot, 'ipc'));
    vi.stubEnv('MYCLAW_IPC_INPUT_DIR', path.join(groupIpcDir, 'input'));

    vi.resetModules();
    const { createIpcAuthEnvelope } = await import('@core/runtime/ipc-auth.js');
    const envelope = createIpcAuthEnvelope(groupFolder, undefined, {
      appId: 'app:team',
      agentId: 'agent:team-main',
    });
    vi.stubEnv('MYCLAW_IPC_AUTH_TOKEN', envelope.authToken);
    vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', envelope.responseVerifyKey);
    vi.stubEnv('MYCLAW_IPC_RESPONSE_KEY_ID', envelope.responseKeyId);
    vi.stubEnv('MYCLAW_PERMISSION_TIMEOUT_MS', '10000');

    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/runner/claude/permission-callback.js');

    const pendingDecision = requestPermissionApproval({
      appId: 'app:team',
      agentId: 'agent:team-main',
      groupFolder,
      toolName: 'edit_file',
    });
    const pendingRequest = await waitForPermissionRequest(
      permissionRequestsDir,
    );
    fs.writeFileSync(
      path.join(permissionResponsesDir, `${pendingRequest.requestId}.json`),
      JSON.stringify(
        {
          requestId: pendingRequest.requestId,
          responseNonce: pendingRequest.raw.responseNonce,
          approved: true,
          decidedBy: 'admin:lead',
        },
        null,
        2,
      ),
    );

    await expect(pendingDecision).resolves.toEqual({
      approved: false,
      reason: 'Permission response signature verification failed',
    });
  });
});
