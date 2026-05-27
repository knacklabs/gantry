import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import {
  createGuardedMcpFetch,
  projectMcpProxyCallerIdentity,
} from '@core/application/mcp/mcp-tool-proxy.js';
import type { MaterializedMcpCapability } from '@core/application/mcp/mcp-server-service.js';

const TEST_SECRET = 'test_secret_thirty_two_bytes_long_xx';

function httpCap(
  overrides: Partial<MaterializedMcpCapability> = {},
): MaterializedMcpCapability {
  return {
    name: 'shopify-api',
    callerIdentity: {
      mode: 'required',
      headerName: 'X-Caller-Identity',
      signingRef: 'SHOPIFY_MCP_IDENTITY_SECRET',
      source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
    },
    config: { type: 'http', url: 'http://127.0.0.1:8081/mcp' },
    allowedToolPatterns: ['get_*'],
    autoApproveToolPatterns: ['get_*'],
    allowedToolNames: [],
    autoApproveToolNames: [],
    required: false,
    ...overrides,
  };
}

describe('createGuardedMcpFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects hostname fetches until MCP proxy has DNS-pinned transport', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      createGuardedMcpFetch({ lookupHostname })(
        'https://mcp.example.test/tools',
      ),
    ).rejects.toThrow('DNS-pinned transport');

    expect(lookupHostname).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows public IP-literal URLs through public-address validation', async () => {
    const lookupHostname = vi.fn();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await createGuardedMcpFetch({ lookupHostname })(
      'https://93.184.216.34/tools',
    );

    expect(lookupHostname).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://93.184.216.34/tools',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});

describe('projectMcpProxyCallerIdentity', () => {
  it('injects signed caller identity headers for Gantry MCP proxy calls', () => {
    const [capability] = projectMcpProxyCallerIdentity({
      capabilities: [httpCap()],
      callerIdentityJid: 'wa:919654405340',
      credentialEnv: { SHOPIFY_MCP_IDENTITY_SECRET: TEST_SECRET },
    });

    expect(capability?.config.type).toBe('http');
    expect(
      (capability?.config as { headers?: Record<string, string> }).headers?.[
        'X-Caller-Identity'
      ],
    ).toMatch(/^phone:\+919654405340;ts:\d+;sig:[0-9a-f]+$/);
  });

  it('does not restrict admin/operator proxy calls when caller identity is disabled', () => {
    const input = httpCap({ callerIdentity: undefined });

    const [capability] = projectMcpProxyCallerIdentity({
      capabilities: [input],
      credentialEnv: {},
    });

    expect(capability).toEqual(input);
  });

  it('returns only customer-safe wording when proxy identity projection fails', () => {
    expect(() =>
      projectMcpProxyCallerIdentity({
        capabilities: [httpCap()],
        callerIdentityJid: 'tg:-123',
        credentialEnv: { SHOPIFY_MCP_IDENTITY_SECRET: TEST_SECRET },
      }),
    ).toThrow(ApplicationError);

    try {
      projectMcpProxyCallerIdentity({
        capabilities: [httpCap()],
        callerIdentityJid: 'tg:-123',
        credentialEnv: { SHOPIFY_MCP_IDENTITY_SECRET: TEST_SECRET },
      });
    } catch (err) {
      expect(err).toMatchObject({
        message:
          'I can only check details linked to the phone number you are messaging from. The phone number, email, or order you asked about does not match that number.',
      });
      expect(err instanceof ApplicationError ? err.details : []).toEqual([
        expect.stringContaining('wa: conversation identity'),
      ]);
      expect(err instanceof Error ? err.message : String(err)).not.toMatch(
        /Gantry|MCP|credential|header|admin|configuration|secret|privacy guard|signed channel|Shopify Admin|bypass/i,
      );
    }
  });
});
