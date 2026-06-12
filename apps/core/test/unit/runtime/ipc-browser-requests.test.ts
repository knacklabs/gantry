import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID, createHmac } from 'crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import {
  computeBrowserIpcAuthToken,
  createIpcAuthEnvelope,
  registerBrowserIpcAuthorization,
  revokeBrowserIpcAuthorization,
} from '@core/runtime/ipc-auth.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import { processBrowserRequestDirectory } from '@core/runtime/ipc-browser-requests.js';
import { clearIpcRateLimitState } from '@core/runtime/ipc-rate-limit.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-browser-ipc-'));
  tempRoots.push(root);
  return root;
}

function signBrowserPayload(
  sourceAgentFolder: string,
  chatJid: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const token = computeBrowserIpcAuthToken(sourceAgentFolder, chatJid);
  return {
    ...payload,
    signature: signIpcRequestPayload(token, payload),
  };
}

async function waitForResponse(
  responsesDir: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      return JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as Record<
        string,
        unknown
      >;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${requestId}`);
}

function deps(): IpcDeps {
  return {
    sendMessage: async () => undefined,
    conversationRoutes: () => ({}),
    registerGroup: async () => undefined,
    syncGroups: async () => undefined,
    getAvailableGroups: () => [],
    writeGroupsSnapshot: async () => undefined,
    onSchedulerChanged: () => undefined,
    requestPermissionApproval: async () => ({ decision: 'deny' }),
    requestUserAnswer: async () => ({ ok: false }),
    opsRepository: {} as IpcDeps['opsRepository'],
  };
}

describe('processBrowserRequestDirectory', () => {
  afterEach(() => {
    clearIpcRateLimitState();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not charge invalid browser IPC files to the authorized request rate bucket', async () => {
    const root = tempRoot();
    const sourceAgentFolder = 'team';
    const chatJid = 'tg:team';
    const browserRequestsDir = path.join(
      root,
      sourceAgentFolder,
      'browser-requests',
    );
    const runnerControlPort = new FilesystemRunnerControlPort(root);
    const responsesDir = path.join(
      root,
      sourceAgentFolder,
      'browser-responses',
    );
    fs.mkdirSync(browserRequestsDir, { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      fs.writeFileSync(
        path.join(browserRequestsDir, `bad-${index}.json`),
        JSON.stringify({
          requestId: `bad-${index}`,
          action: 'status',
          signature: createHmac('sha256', 'wrong').update('bad').digest('hex'),
        }),
      );
    }

    const logger = { warn: () => undefined, error: () => undefined };
    processBrowserRequestDirectory({
      ipcBaseDir: root,
      sourceAgentFolder,
      browserRequestsDir,
      runnerControlPort,
      deps: deps(),
      logger,
    });

    const responseEnvelope = createIpcAuthEnvelope(sourceAgentFolder);
    const requestId = `browser-${randomUUID()}`;
    const payload = {
      requestId,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'status',
      payload: {},
      context: {
        chatJid,
        responseKeyId: responseEnvelope.responseKeyId,
      },
    };
    registerBrowserIpcAuthorization({
      workspaceKey: sourceAgentFolder,
      chatJid,
    });
    try {
      fs.writeFileSync(
        path.join(browserRequestsDir, `${requestId}.json`),
        JSON.stringify(signBrowserPayload(sourceAgentFolder, chatJid, payload)),
      );
      processBrowserRequestDirectory({
        ipcBaseDir: root,
        sourceAgentFolder,
        browserRequestsDir,
        runnerControlPort,
        deps: deps(),
        logger,
      });

      await expect(
        waitForResponse(responsesDir, requestId),
      ).resolves.toMatchObject({
        requestId,
        ok: true,
      });
    } finally {
      revokeBrowserIpcAuthorization({
        workspaceKey: sourceAgentFolder,
        chatJid,
      });
    }
  });
});
