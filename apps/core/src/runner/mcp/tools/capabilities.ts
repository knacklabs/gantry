import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS,
  listBuiltinSemanticCapabilities,
} from '../../../shared/semantic-capabilities.js';

type ToolResponse = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export type CapabilityReviewSubmitter = (
  toolName: 'request_permission',
  requestLabel: string,
  payload: Record<string, unknown>,
) => Promise<ToolResponse>;

export function registerSemanticCapabilityTools(
  server: McpServer,
  submitCapabilityReviewTask: CapabilityReviewSubmitter,
): void {
  server.tool(
    'capability_search',
    'Search built-in semantic capabilities by app, action, or capability id.',
    {
      query: z.string().optional().describe('Optional search text'),
    },
    async (args) => {
      const query = (args.query ?? '').trim().toLowerCase();
      const capabilities = listBuiltinSemanticCapabilities().filter(
        (capability) =>
          !query ||
          [
            capability.capabilityId,
            capability.displayName,
            capability.category,
            capability.can,
            capability.cannot,
          ]
            .join(' ')
            .toLowerCase()
            .includes(query),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text:
              capabilities
                .map((capability) =>
                  [
                    `- ${capability.displayName}`,
                    `  capability_id: ${capability.capabilityId}`,
                    `  risk: ${capability.risk}`,
                    capability.accountLabel
                      ? `  access: ${capability.accountLabel}`
                      : undefined,
                    `  request_capability: capabilityId=${capability.capabilityId} reason="<why this agent needs it>"`,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                )
                .join('\n') || 'No matching semantic capabilities.',
          },
        ],
      };
    },
  );

  server.tool(
    'request_capability',
    'Request a semantic capability such as Google Sheets write for same-conversation approval.',
    {
      capabilityId: z
        .string()
        .describe('Stable semantic capability id, such as google.sheets.write'),
      reason: z.string().describe('Why this agent needs the capability'),
      accountLabel: z
        .string()
        .optional()
        .describe('Optional non-secret account or workspace label'),
    },
    async (args) => {
      const capability = listBuiltinSemanticCapabilities().find(
        (candidate) => candidate.capabilityId === args.capabilityId,
      );
      return submitCapabilityReviewTask('request_permission', 'Capability', {
        permissionKind: 'tool',
        capabilityId: args.capabilityId,
        capabilityDisplayName: capability?.displayName ?? args.capabilityId,
        accountLabel: args.accountLabel ?? capability?.accountLabel,
        can: capability?.can,
        cannot: capability?.cannot,
        credentialSource: capability?.credentialSource ?? 'none',
        risk: capability?.risk,
        temporaryOnly: false,
        reason: args.reason,
      });
    },
  );

  server.tool(
    'propose_local_cli_capability',
    'Propose a reviewed user-defined local CLI semantic capability draft with pinned executable and scoped command templates. Draft approval does not create runnable Bash authority until runtime local-CLI enforcement exists.',
    {
      capabilityId: z
        .string()
        .describe('Stable semantic id, such as acme.invoices.read'),
      displayName: z
        .string()
        .describe('User-facing name, such as Acme invoices read'),
      category: z.string().describe('Provider or app group'),
      risk: z.enum(['read', 'write', 'admin']),
      accountLabel: z
        .string()
        .optional()
        .describe('Non-secret account/workspace label'),
      can: z.string().describe('What the approved capability allows'),
      cannot: z.string().describe('What the capability explicitly excludes'),
      executablePath: z.string().describe('Pinned absolute executable path'),
      executableVersion: z.string().describe('Pinned executable version'),
      executableHash: z
        .string()
        .describe('Pinned executable content hash when available'),
      commandTemplates: z
        .array(z.string())
        .describe('Scoped command templates, never broad cli *'),
      authPreflightCommand: z
        .string()
        .optional()
        .describe('Exact auth/account health check command'),
      protectedPaths: z
        .array(z.string())
        .optional()
        .describe('Credential/config paths agents may read but not write'),
      deniedEnvPatterns: z
        .array(z.string())
        .optional()
        .describe('Additional denied env override patterns'),
      reason: z.string().describe('Why this local CLI capability is needed'),
    },
    async (args) =>
      submitCapabilityReviewTask('request_permission', 'Local CLI capability', {
        permissionKind: 'tool',
        capabilityId: args.capabilityId,
        capabilityDisplayName: args.displayName,
        category: args.category,
        risk: args.risk,
        accountLabel: args.accountLabel,
        can: args.can,
        cannot: args.cannot,
        credentialSource: 'local_cli',
        executablePath: args.executablePath,
        executableVersion: args.executableVersion,
        executableHash: args.executableHash,
        commandTemplates: args.commandTemplates,
        authPreflightCommand: args.authPreflightCommand,
        protectedPaths: args.protectedPaths ?? [],
        deniedEnvPatterns: [
          ...DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS,
          ...(args.deniedEnvPatterns ?? []),
        ],
        temporaryOnly: false,
        reason: args.reason,
      }),
  );

  server.tool(
    'manage_capability',
    'Show the current semantic capability management guidance for view, change, revoke, test connection, and audit actions.',
    {
      action: z.enum(['view', 'change', 'revoke', 'test_connection', 'audit']),
      capabilityId: z.string().optional(),
    },
    async (args) => ({
      content: [
        {
          type: 'text' as const,
          text: [
            `Action: ${args.action}`,
            args.capabilityId
              ? `Capability: ${args.capabilityId}`
              : 'Capability: all selected capabilities',
            'Use the Control API /v1/agents/:agentId/capabilities or local admin CLI to change durable bindings.',
            'Use capability_status for current run access and request_capability/propose_local_cli_capability for reviewed additions.',
            'Revocation and account changes update settings.yaml and the Postgres projection; raw tokens are never shown.',
          ].join('\n'),
        },
      ],
    }),
  );
}
