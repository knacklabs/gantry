import { describe, expect, it } from 'vitest';

import { resolveMcpCredentialEnvForAgent } from '@core/application/capability-secrets/mcp-secret-projection.js';
import type { MaterializedMcpServer } from '@core/domain/mcp/mcp-servers.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
} from '@core/domain/ports/repositories.js';

function fakeMcpServers(records: MaterializedMcpServer[]): McpServerRepository {
  return {
    listMaterializedServersForAgent: async () => records,
  } as unknown as McpServerRepository;
}

function fakeSecrets(
  stored: Record<string, { value: string; allowedCapabilityIds?: string[] }>,
): { repo: CapabilitySecretRepository; calls: string[] } {
  const calls: string[] = [];
  const repo = {
    getSecret: async ({ name }: { name: string }) => {
      calls.push(name);
      const entry = stored[name];
      return entry
        ? {
            value: entry.value,
            allowedCapabilityIds: entry.allowedCapabilityIds ?? [],
          }
        : null;
    },
  } as unknown as CapabilitySecretRepository;
  return { repo, calls };
}

function httpRecord(opts: {
  name: string;
  signingRef?: string;
  credentialRefs?: { name: string; target: 'env' | 'header'; key: string }[];
}): MaterializedMcpServer {
  return {
    definition: {
      id: `srv-${opts.name}` as never,
      appId: 'app' as never,
      name: opts.name,
      status: 'active',
      createdSource: 'admin',
      riskClass: 'medium',
      transport: 'http',
      config: {
        transport: 'http',
        url: 'http://127.0.0.1:8082/mcp',
        ...(opts.signingRef
          ? {
              callerIdentity: {
                mode: 'required',
                headerName: 'x-caller-identity',
                signingRef: opts.signingRef,
                source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
              },
            }
          : {}),
      },
      allowedToolPatterns: ['*'],
      autoApproveToolPatterns: [],
      credentialRefs: opts.credentialRefs ?? [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as never,
    binding: { required: false } as never,
  } as never;
}

describe('resolveMcpCredentialEnvForAgent', () => {
  it('resolves an http connector signing secret from runtime env, not the store', async () => {
    const { repo, calls } = fakeSecrets({});
    const env = await resolveMcpCredentialEnvForAgent({
      appId: 'app' as never,
      agentId: 'agent' as never,
      mcpServers: fakeMcpServers([
        httpRecord({
          name: 'boondi-crm',
          signingRef: 'MCP_IDENTITY_SECRET',
          credentialRefs: [
            {
              name: 'BOONDI_CRM_DATABASE_URL',
              target: 'env',
              key: 'BOONDI_CRM_DATABASE_URL',
            },
          ],
        }),
      ]),
      secrets: repo,
      readRuntimeEnv: (name) =>
        name === 'MCP_IDENTITY_SECRET' ? 'shared-hmac' : '',
    });
    expect(env).toEqual({ MCP_IDENTITY_SECRET: 'shared-hmac' });
    // The store is never consulted for an http connector — not for the signing
    // secret, and not for the connector-owned credential_refs.
    expect(calls).toEqual([]);
  });

  it('logs a clear error and omits the secret when an http signing key is missing from runtime env', async () => {
    const errors: { data: Record<string, unknown>; msg: string }[] = [];
    const { repo } = fakeSecrets({});
    const env = await resolveMcpCredentialEnvForAgent({
      appId: 'app' as never,
      agentId: 'agent' as never,
      mcpServers: fakeMcpServers([
        httpRecord({
          name: 'boondi-crm',
          signingRef: 'MCP_IDENTITY_SECRET',
        }),
      ]),
      secrets: repo,
      readRuntimeEnv: () => '',
      logger: { error: (data, msg) => errors.push({ data, msg }) },
    });
    expect(env).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('mcp_signing_secret_missing_from_env');
    expect(errors[0]!.data).toMatchObject({
      server: 'boondi-crm',
      signingRef: 'MCP_IDENTITY_SECRET',
    });
  });

  it('still resolves stdio_template credentials from the secret store', async () => {
    const { repo, calls } = fakeSecrets({ GITHUB_TOKEN: { value: 'ght' } });
    const env = await resolveMcpCredentialEnvForAgent({
      appId: 'app' as never,
      agentId: 'agent' as never,
      mcpServers: fakeMcpServers([
        {
          definition: {
            id: 'srv-github' as never,
            appId: 'app' as never,
            name: 'github',
            status: 'active',
            createdSource: 'admin',
            riskClass: 'medium',
            transport: 'stdio_template',
            config: { transport: 'stdio_template', templateId: 'github' },
            allowedToolPatterns: ['*'],
            autoApproveToolPatterns: [],
            credentialRefs: [
              { name: 'GITHUB_TOKEN', target: 'env', key: 'GITHUB_TOKEN' },
            ],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          } as never,
          binding: { required: false } as never,
        } as never,
      ]),
      secrets: repo,
      readRuntimeEnv: () => 'must-not-be-used',
    });
    expect(env).toEqual({ GITHUB_TOKEN: 'ght' });
    expect(calls).toContain('GITHUB_TOKEN');
  });
});
