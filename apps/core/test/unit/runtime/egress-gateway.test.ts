import http from 'http';
import dns from 'node:dns/promises';
import net from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeEgressGateway,
  closeEgressGatewaysForTest,
  ensureEgressGateway,
} from '@core/runtime/egress-gateway.js';
import { SANDBOX_RUNTIME_MODEL_GATEWAY_HOST } from '@core/runtime/agent-spawn-runtime-policy.js';

beforeEach(() => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeEgressGatewaysForTest();
});

describe('egress gateway', () => {
  it('blocks private CONNECT targets by default and audits the decision', async () => {
    const target = await startTargetServer();
    const publishRuntimeEvent = vi.fn();
    const gateway = await ensureEgressGateway({
      key: 'test:allow',
      settings: { denylist: [] },
      principal: {
        appId: 'default',
        agentId: 'agent:test',
        conversationId: 'tg:test',
        runId: 'run-1',
      },
      publishRuntimeEvent,
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: `127.0.0.1:${target.port}`,
    });

    expect(response.statusCode).toBe(403);
    const auditEvent = publishRuntimeEvent.mock.calls[0]?.[0];
    expect(auditEvent).toEqual(
      expect.objectContaining({
        eventType: 'egress.connect',
        agentId: 'agent:test',
        conversationId: 'conversation:tg:test',
        payload: expect.objectContaining({
          host: '127.0.0.1',
          allowed: false,
          denied: true,
          reason: expect.stringContaining('Network blocked by policy'),
          principal: 'agent:test',
          conversationId: 'tg:test',
          runId: 'run-1',
        }),
      }),
    );
    expect(auditEvent).not.toHaveProperty('runId');
    await target.close();
  });

  it('attributes a declared host to its reviewed capability in the audit event', async () => {
    const upstream = await startRecordingProxy();
    const publishRuntimeEvent = vi.fn();
    const gateway = await ensureEgressGateway({
      key: 'test:attribution',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      networkAttribution: [
        {
          host: 'api.linkedin.com:443',
          capabilityId: 'skill.linkedin-posting.publish',
          capabilityLabel: 'LinkedIn Posting publish',
        },
      ],
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
      publishRuntimeEvent,
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    // Default-allow: the declared host is reviewed audit metadata, so traffic
    // passes through normally while DNS pinning keeps the tunnel public and the
    // audit event still names the capability that declared it.
    expect(response.statusCode).toBe(502);
    expect(upstream.headers[0]).toContain('CONNECT 93.184.216.34:443 HTTP/1.1');
    expect(upstream.headers[0]).toContain('Host: api.linkedin.com:443');
    const auditEvent = publishRuntimeEvent.mock.calls[0]?.[0];
    expect(auditEvent).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          host: 'api.linkedin.com',
          allowed: true,
          capabilityId: 'skill.linkedin-posting.publish',
          capabilityLabel: 'LinkedIn Posting publish',
        }),
      }),
    );
    await upstream.close();
  });

  it('allows undeclared public hosts by default when capability network hosts are present', async () => {
    const upstream = await startRecordingProxy();
    const publishRuntimeEvent = vi.fn();
    const gateway = await ensureEgressGateway({
      key: 'test:attribution-undeclared-host',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      networkAttribution: [
        {
          host: 'api.linkedin.com:443',
          capabilityId: 'skill.linkedin-posting.publish',
          capabilityLabel: 'LinkedIn Posting publish',
        },
      ],
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
      publishRuntimeEvent,
    });

    // Declared hosts are reviewed metadata, not an allowlist: an approved run
    // can still reach other public hosts through the gateway by default.
    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'example.com:443',
    });

    expect(response.statusCode).toBe(502);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          host: 'example.com',
          allowed: true,
          denied: false,
          reason: 'default_allow',
        }),
      }),
    );
    await upstream.close();
  });

  it('blocks undeclared public hosts when a sandbox allowlist is configured', async () => {
    const upstream = await startRecordingProxy();
    const publishRuntimeEvent = vi.fn();
    const gateway = await ensureEgressGateway({
      key: 'test:sandbox-allowlist',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      allowedNetworkHosts: ['api.linkedin.com:443'],
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
      publishRuntimeEvent,
    });

    const denied = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'example.com:443',
    });
    const allowed = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(502);
    expect(upstream.headers[0]).toContain('CONNECT 93.184.216.34:443 HTTP/1.1');
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          host: 'example.com',
          denied: true,
          reason: 'not_allowed_by_runtime_sandbox',
        }),
      }),
    );
    await upstream.close();
  });

  it('keeps model provider hosts out of the sandbox tool allowlist', async () => {
    const publishRuntimeEvent = vi.fn();
    const upstream = await startRecordingProxy();
    const gateway = await ensureEgressGateway({
      key: 'test:sandbox-model-provider-allowlist',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      allowedNetworkHosts: ['api.linkedin.com:443'],
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
      publishRuntimeEvent,
    });

    const denied = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.anthropic.com:443',
    });

    expect(denied.statusCode).toBe(403);
    expect(upstream.headers).toHaveLength(0);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          host: 'api.anthropic.com',
          denied: true,
          reason: 'not_allowed_by_runtime_sandbox',
        }),
      }),
    );
    await upstream.close();
  });

  it('allows IPv6 loopback model gateway HTTP requests under a sandbox allowlist', async () => {
    const publishRuntimeEvent = vi.fn();
    const gateway = await ensureEgressGateway({
      key: 'test:sandbox-ipv6-model-gateway',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      allowedNetworkHosts: ['api.anthropic.com:443'],
      allowedPrivateNetworkHosts: ['[::1]:18999'],
      publishRuntimeEvent,
    });

    const response = await httpProxyRequestThroughGateway({
      gatewayPort: gateway.port,
      url: 'http://[::1]:18999/v1/messages',
    });

    expect(response.statusCode).toBe(502);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          host: '::1',
          allowed: true,
          denied: false,
          reason: 'model_gateway_allow',
        }),
      }),
    );
  });

  it('maps sandbox model gateway aliases to the loopback model gateway', async () => {
    const target = await startTargetServer();
    const publishRuntimeEvent = vi.fn();
    const authority = `${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:${target.port}`;
    const gateway = await ensureEgressGateway({
      key: 'test:sandbox-model-gateway-alias',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      allowedNetworkHosts: [authority],
      privateNetworkHostMappings: [{ authority, connectHost: '127.0.0.1' }],
      publishRuntimeEvent,
    });

    try {
      const response = await httpProxyRequestThroughGateway({
        gatewayPort: gateway.port,
        url: `http://${authority}/v1/messages`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('ok');
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            host: SANDBOX_RUNTIME_MODEL_GATEWAY_HOST,
            allowed: true,
            denied: false,
            reason: 'model_gateway_allow',
          }),
        }),
      );
    } finally {
      await target.close();
    }
  });

  it('pins upstream-proxied HTTP requests to the locally resolved public address', async () => {
    const upstream = await startRecordingProxy();
    const gateway = await ensureEgressGateway({
      key: 'test:http-pinned-upstream',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
    });

    const response = await httpProxyRequestThroughGateway({
      gatewayPort: gateway.port,
      url: 'http://api.linkedin.com/feed?q=1',
    });

    expect(response.statusCode).toBe(502);
    expect(upstream.headers[0]).toContain(
      'GET http://93.184.216.34/feed?q=1 HTTP/1.1',
    );
    expect(upstream.headers[0]?.toLowerCase()).toContain(
      'host: api.linkedin.com',
    );
    await upstream.close();
  });

  it('does not return a Gantry 403 for an approved declared public host (regression)', async () => {
    const upstream = await startRecordingProxy();
    const gateway = await ensureEgressGateway({
      key: 'test:attribution-linkedin-regression',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      // An approved linkedin-posting skill action that declared its hosts, run
      // interactively without a runtime DNS validator configured.
      networkAttribution: [
        {
          host: 'api.linkedin.com:443',
          capabilityId: 'skill.linkedin-posting.publish',
          capabilityLabel: 'LinkedIn Posting publish',
        },
      ],
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    // Previously the missing host validator turned a declared host into a
    // CONNECT 403; now the approved capability reaches public hosts through the
    // gateway while DNS pinning keeps private targets blocked.
    expect(response.statusCode).not.toBe(403);
    expect(upstream.headers[0]).toContain('CONNECT 93.184.216.34:443 HTTP/1.1');
    expect(upstream.headers[0]).toContain('Host: api.linkedin.com:443');
    await upstream.close();
  });

  it('keeps default-allowed CONNECT traffic working when audit persistence fails', async () => {
    const upstream = await startRecordingProxy();
    const publishRuntimeEvent = vi.fn(async () => {
      throw new Error('audit store unavailable');
    });
    const gateway = await ensureEgressGateway({
      key: 'test:allow-audit-failure',
      settings: { denylist: [] },
      principal: {
        appId: 'default',
        agentId: 'agent:test',
        conversationId: 'tg:test',
      },
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
      publishRuntimeEvent,
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    expect(response.statusCode).toBe(502);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'egress.connect' }),
    );
    await upstream.close();
  });

  it('returns useful 403 JSON when denylist matches', async () => {
    const gateway = await ensureEgressGateway({
      key: 'test:deny',
      settings: { denylist: ['api.linkedin.com'] },
      principal: { appId: 'default', agentId: 'agent:test' },
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      deniedHost: 'api.linkedin.com',
      matchedPattern: 'api.linkedin.com',
      reason:
        'Host api.linkedin.com matched permissions.egress.denylist pattern api.linkedin.com.',
    });
  });

  it('applies denylist rules to trailing-dot CONNECT hostnames', async () => {
    const gateway = await ensureEgressGateway({
      key: 'test:deny-trailing-dot',
      settings: { denylist: ['api.linkedin.com'] },
      principal: { appId: 'default', agentId: 'agent:test' },
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com.:443',
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      deniedHost: 'api.linkedin.com',
      matchedPattern: 'api.linkedin.com',
      reason:
        'Host api.linkedin.com matched permissions.egress.denylist pattern api.linkedin.com.',
    });
  });

  it('returns 502 when upstream proxy closes before CONNECT headers', async () => {
    const upstream = await startClosingProxy();
    const gateway = await ensureEgressGateway({
      key: 'test:upstream-close',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
    });

    const response = await connectThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    expect(response.statusCode).toBe(502);
    await upstream.close();
  });

  it('closes promptly while CONNECT tunnels are still open', async () => {
    const upstream = await startHoldingProxy();
    const gateway = await ensureEgressGateway({
      key: 'test:close-open-connect',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
    });

    const tunnel = await openTunnelThroughGateway({
      gatewayPort: gateway.port,
      authority: 'api.linkedin.com:443',
    });

    await expect(
      Promise.race([
        closeEgressGateway(gateway),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('closeEgressGateway timed out')),
            500,
          ),
        ),
      ]),
    ).resolves.toBeUndefined();
    await waitForSocketClose(tunnel);
    await upstream.close();
  });

  it('keeps running when a CONNECT client resets an established tunnel', async () => {
    const upstream = await startHoldingProxy();
    const gateway = await ensureEgressGateway({
      key: 'test:client-reset-connect',
      settings: { denylist: [] },
      principal: { appId: 'default', agentId: 'agent:test' },
      upstreamProxy: {
        provider: 'test-proxy',
        url: `http://127.0.0.1:${upstream.port}/`,
      },
    });
    const uncaught = vi.fn();
    process.once('uncaughtException', uncaught);

    try {
      const tunnel = await openTunnelThroughGateway({
        gatewayPort: gateway.port,
        authority: 'api.linkedin.com:443',
      });
      tunnel.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.removeListener('uncaughtException', uncaught);
      await upstream.close();
    }
  });
});

async function startTargetServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.end('ok');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Target server did not bind to TCP.');
  }
  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startClosingProxy(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Closing proxy did not bind to TCP.');
  }
  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startRecordingProxy(): Promise<{
  port: number;
  headers: string[];
  close: () => Promise<void>;
}> {
  const headers: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    let buffered = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\r\n\r\n')) return;
      headers.push(buffered.slice(0, buffered.indexOf('\r\n\r\n')));
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Recording proxy did not bind to TCP.');
  }
  return {
    port: address.port,
    headers,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function startHoldingTarget(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Holding target did not bind to TCP.');
  }
  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function startHoldingProxy(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    let buffered = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\r\n\r\n')) return;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.removeAllListeners('data');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Holding proxy did not bind to TCP.');
  }
  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function openTunnelThroughGateway(input: {
  gatewayPort: number;
  authority: string;
}): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const socket = net.connect(input.gatewayPort, '127.0.0.1', () => {
      socket.write(
        [`CONNECT ${input.authority} HTTP/1.1`, `Host: ${input.authority}`, '']
          .join('\r\n')
          .concat('\r\n'),
      );
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!/^HTTP\/1\.[01]\s+200\b/.test(response)) {
        socket.destroy();
        reject(new Error(`CONNECT response was not 200: ${response}`));
        return;
      }
      resolve(socket);
    };
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for CONNECT response: ${response}`));
    }, 1_000);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) finish();
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Socket did not close after gateway shutdown'));
    }, 500);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function httpProxyRequestThroughGateway(input: {
  gatewayPort: number;
  url: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: input.gatewayPort,
        method: 'GET',
        path: input.url,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectThroughGateway(input: {
  gatewayPort: number;
  authority: string;
}): Promise<{ statusCode: number; statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const socket = net.connect(input.gatewayPort, '127.0.0.1', () => {
      socket.write(
        [`CONNECT ${input.authority} HTTP/1.1`, `Host: ${input.authority}`, '']
          .join('\r\n')
          .concat('\r\n'),
      );
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const statusLine = response.split('\r\n', 1)[0] ?? '';
      const status = statusLine.match(/^HTTP\/1\.[01]\s+(\d+)/);
      if (!status) {
        reject(
          new Error(`CONNECT response did not include a status: ${response}`),
        );
        return;
      }
      const [, statusCode] = status;
      const body = response.includes('\r\n\r\n')
        ? response.slice(response.indexOf('\r\n\r\n') + 4)
        : '';
      resolve({ statusCode: Number(statusCode), statusLine, body });
    };
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for CONNECT response: ${response}`));
    }, 1_000);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) {
        socket.end();
      }
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    socket.once('end', finish);
    socket.once('close', finish);
  });
}

function httpRequestThroughGateway(input: {
  gatewayPort: number;
  url: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: input.gatewayPort,
        method: 'GET',
        path: input.url,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
