import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createGantryFacadeTools } from '@core/adapters/llm/deepagents-langchain/runner/gantry-facade-tools.js';
import {
  createIpcResponseSigningKeyPair,
  signIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { resolvePinnedPublicMcpAddress } from '@core/shared/dns-pinned-fetch.js';

// Fix: public-address-checks-are-copied-in-seve.
describe('network destination address checks', () => {
  it.each([
    ['0.1.2.3', false],
    ['10.1.2.3', false],
    ['127.1.2.3', false],
    ['100.64.1.2', false],
    ['169.254.1.2', false],
    ['172.16.1.2', false],
    ['192.168.1.2', false],
    ['192.0.0.1', false],
    ['192.0.2.1', false],
    ['198.18.0.1', false],
    ['198.19.0.1', false],
    ['198.51.100.1', false],
    ['203.0.113.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['[::ffff:127.0.0.1]', false],
    ['[::ffff:7f00:1]', false],
    ['[::ffff:8.8.8.8]', false],
    ['[2606:4700:4700::1111]', false],
    ['8.8.8.8', true],
    ['example.com', true],
    ['999.1.2.3', false],
    ['[2001:::1]', false],
  ])('WebRead checks %s before sending to its proxy', async (host, allowed) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'network-addresses-'));
    const requests: string[] = [];
    const proxy = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end('<p>public response</p>');
    });
    try {
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      );
      const address = proxy.address();
      if (!address || typeof address === 'string')
        throw new Error('No proxy port');
      const proxyUrl = `http://127.0.0.1:${address.port}/`;
      const keys = createIpcResponseSigningKeyPair();
      const webRead = createGantryFacadeTools({
        workspaceFolder: 'main_agent',
        memoryBlock: '',
        configuredAllowedTools: ['WebRead'],
        toolNetworkEnv: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NODE_USE_ENV_PROXY: '1',
        },
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {
          appId: 'default',
          agentId: 'agent:main_agent',
          chatJid: 'tg:group',
          jobId: '',
          jobName: '',
          jobRunId: '',
          jobRunLeaseToken: '',
          jobRunLeaseFencingVersion: '',
          ipcAuthToken: 'ipc-auth',
          ipcResponseVerifyKey: keys.publicKeyPem,
          ipcResponseKeyId: 'key-id',
          permissionRequestTimeoutMs: 5_000,
          resolveWorkspaceIpcDir: () => root,
        },
        capabilityRequestToolsHidden: false,
        filesystemToolsEnabled: false,
      }).find((item) => item.name === 'WebRead');
      if (!webRead) throw new Error('No WebRead tool');
      const url = `https://${host}/page`;
      const invocation = webRead.invoke({ url });
      if (host === '999.1.2.3') {
        await expect(invocation).resolves.toMatchObject({
          isError: true,
          error: {
            category: 'validation',
            message: 'WebRead url must be an http(s) URL.',
          },
        });
        expect(requests).toEqual([]);
        return;
      }
      if (host === '[2001:::1]') {
        await expect(invocation).rejects.toThrow(
          'Received tool input did not match expected schema',
        );
        expect(requests).toEqual([]);
        return;
      }
      // Approve through the real signed IPC client; only the remote proxy is fake.
      const requestDir = path.join(root, 'permission-requests');
      const requestFile = await vi.waitFor(() => {
        const files = fs
          .readdirSync(requestDir)
          .filter((file) => file.endsWith('.json'));
        expect(files).toHaveLength(1);
        return files[0]!;
      });
      const request = JSON.parse(
        fs.readFileSync(path.join(requestDir, requestFile), 'utf8'),
      ) as {
        requestId: string;
        responseNonce: string;
      };
      const response = {
        requestId: request.requestId,
        responseNonce: request.responseNonce,
        approved: true,
        mode: 'allow_once',
      };
      fs.writeFileSync(
        path.join(root, 'permission-responses', requestFile),
        JSON.stringify({
          ...response,
          signature: signIpcResponsePayload(keys.privateKeyPem, response),
        }),
      );
      const result = await invocation;
      if (allowed) {
        expect(result).toBe('public response');
        expect(requests).toEqual([new URL(url).toString()]);
      } else {
        expect(result).toBe(
          'WebRead cannot read loopback or private network URLs.',
        );
        expect(requests).toEqual([]);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['0:0:0:0:0:ffff:7f00:1', false],
    ['[::ffff:127.0.0.1]', false],
    ['::ffff:8.8.8.8', true],
    ['::ffff:808:808', true],
    ['0:0:0:0:0:ffff:808:808', true],
    ['::', false],
    ['::1', false],
    ['fc00::1', false],
    ['fe80::1%eth0', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['2001:2::1', false],
    ['2001:10::1', false],
    ['2002::1', false],
    ['64:ff9b:1::1', false],
    ['2606:4700:4700::1111', true],
    ['', false],
    ['not-an-address', false],
    ['999.1.2.3', false],
    ['2001:::1', false],
    ['::ffff:999.1.2.3', false],
  ])(
    'DNS-pinned fetch validates resolved address %s',
    async (address, allowed) => {
      const record = { address, family: 6 as const };
      const resolution = resolvePinnedPublicMcpAddress(
        'mcp.example.test',
        async () => [record],
      );
      if (allowed) {
        await expect(resolution).resolves.toEqual(record);
      } else {
        await expect(resolution).rejects.toThrow(
          'MCP server hostname must resolve only to public routable addresses.',
        );
      }
    },
  );
});
