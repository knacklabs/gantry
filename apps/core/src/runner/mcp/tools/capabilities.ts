import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS,
  type SemanticCapabilityDefinition,
  validateSemanticCapabilityDefinition,
} from '../../../shared/semantic-capabilities.js';
import {
  NO_REVIEWED_CAPABILITY_GUIDANCE,
  SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
  UNREVIEWED_DISCOVERY_GUIDANCE,
} from '../../../shared/capability-guidance.js';

type ToolResponse = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export type CapabilityReviewSubmitter = (
  toolName: 'request_permission',
  requestLabel: string,
  payload: Record<string, unknown>,
) => Promise<ToolResponse>;

export type SemanticCapabilityProvider = () =>
  | readonly SemanticCapabilityDefinition[]
  | Promise<readonly SemanticCapabilityDefinition[]>;

const CAPABILITY_SOURCES = [
  'skill',
  'mcp',
  'adapter',
  'local_cli',
  'generated_command',
  'composite',
] as const;

const CAPABILITY_CREDENTIAL_SOURCES = [
  'none',
  'configured_access',
  'skill',
  'mcp',
  'adapter',
  'local_cli',
  'generated_command',
  'composite',
] as const;

export function registerSemanticCapabilityTools(
  server: McpServer,
  submitCapabilityReviewTask: CapabilityReviewSubmitter,
  options: { listCapabilities?: SemanticCapabilityProvider } = {},
): void {
  server.tool(
    'capability_search',
    'Search reviewed capabilities only by source, app, action, or capability id. Unreviewed CLI help, MCP tools, skill text, and adapter discoveries are inventory, not public capability definitions.',
    {
      query: z.string().optional().describe('Optional search text'),
    },
    async (args) => {
      const query = (args.query ?? '').trim().toLowerCase();
      const capabilities = (
        await availableSemanticCapabilities(options)
      ).filter(
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
                    `  source: ${capability.credentialSource}`,
                    capability.accountLabel
                      ? `  access: ${capability.accountLabel}`
                      : undefined,
                    `  grant_request: propose_capability capabilityId=${capability.capabilityId} reason="<why this agent needs it>"`,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                )
                .join('\n') || NO_REVIEWED_CAPABILITY_GUIDANCE,
          },
        ],
      };
    },
  );

  server.tool(
    'propose_capability',
    'Request an approved semantic capability by id. For user-defined local CLI access, propose a reviewed local_cli capability with pinned executable, templates, preflight, and protected paths.',
    {
      capabilityId: z
        .string()
        .describe('Stable semantic id, such as acme.invoices.read'),
      displayName: z
        .string()
        .optional()
        .describe('User-facing name, such as Acme invoices read'),
      category: z.string().optional().describe('Provider or app group'),
      risk: z.enum(['read', 'write', 'admin']).optional(),
      source: z
        .enum(CAPABILITY_SOURCES)
        .default('composite')
        .describe(
          'Capability source family. New user-defined proposals currently require local_cli; available capability ids ignore this field.',
        ),
      credentialSource: z
        .enum(CAPABILITY_CREDENTIAL_SOURCES)
        .default('none')
        .describe('Where runtime credentials or authority are brokered'),
      accountLabel: z
        .string()
        .optional()
        .describe('Non-secret account/workspace label'),
      can: z
        .string()
        .optional()
        .describe('What the approved capability allows'),
      cannot: z
        .string()
        .optional()
        .describe('What the capability explicitly excludes'),
      sourceRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Reviewed source references such as skill hash, MCP server version/tool hash, adapter ref, CLI executable hash, or command template hash',
        ),
      bindings: z
        .array(z.string())
        .optional()
        .describe(
          'Typed binding labels such as skill_action, mcp_action, gantry_tool, adapter_action, local_cli, or run_command_template',
        ),
      executablePath: z
        .string()
        .optional()
        .describe('Pinned absolute executable path for local_cli proposals'),
      executableVersion: z
        .string()
        .optional()
        .describe('Pinned executable version for local_cli proposals'),
      executableHash: z
        .string()
        .optional()
        .describe('Pinned executable content hash for local_cli proposals'),
      commandTemplates: z
        .array(z.string())
        .optional()
        .describe('Scoped command templates, never broad cli *'),
      authPreflightCommand: z
        .string()
        .optional()
        .describe('Exact auth/account health check command'),
      protectedPaths: z
        .array(z.string())
        .optional()
        .describe('Credential/config paths agents may read but not write'),
      networkHosts: z
        .array(z.string())
        .optional()
        .describe('Network hostnames the reviewed local CLI may contact'),
      deniedEnvPatterns: z
        .array(z.string())
        .optional()
        .describe('Additional denied env override patterns'),
      reason: z.string().describe('Why this capability is needed'),
    },
    async (args) => {
      const hasProposalManifest =
        args.source === 'local_cli' ||
        args.credentialSource === 'local_cli' ||
        Boolean(args.executablePath) ||
        Boolean(args.executableVersion) ||
        Boolean(args.executableHash) ||
        Boolean(args.commandTemplates?.length);
      const approved = (await availableSemanticCapabilities(options)).find(
        (candidate) => candidate.capabilityId === args.capabilityId,
      );
      if (approved && !hasProposalManifest) {
        return submitCapabilityReviewTask('request_permission', 'Capability', {
          permissionKind: 'tool',
          capabilityRequestSource: 'propose_capability',
          capabilityId: approved.capabilityId,
          capabilityDisplayName: approved.displayName,
          accountLabel: args.accountLabel ?? approved.accountLabel,
          can: approved.can,
          cannot: approved.cannot,
          credentialSource: approved.credentialSource,
          semanticCapabilityDefinition: approved,
          risk: approved.risk,
          temporaryOnly: false,
          reason: args.reason,
        });
      }
      const missingManifestFields = [
        args.displayName ? undefined : 'displayName',
        args.category ? undefined : 'category',
        args.risk ? undefined : 'risk',
        args.can ? undefined : 'can',
        args.cannot ? undefined : 'cannot',
      ].filter(Boolean);
      if (missingManifestFields.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: [
                `New capability proposals require ${missingManifestFields.join(', ')}.`,
                'Use only capabilityId and reason when requesting an already-reviewed capability from capability_search.',
                SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
              ].join('\n'),
            },
          ],
        };
      }
      const isLocalCli =
        args.source === 'local_cli' || args.credentialSource === 'local_cli';
      if (!isLocalCli) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: [
                'New capability proposals currently require source=local_cli with pinned executable details.',
                'For skills, MCP servers, adapters, and Gantry built-ins, attach or refresh the source and send the discovered action through review.',
                UNREVIEWED_DISCOVERY_GUIDANCE,
                'Use capability_search and capabilityId+reason for already-reviewed capabilities.',
              ].join('\n'),
            },
          ],
        };
      }
      if (isLocalCli) {
        const missing = [
          args.executablePath ? undefined : 'executablePath',
          args.executableVersion ? undefined : 'executableVersion',
          args.executableHash ? undefined : 'executableHash',
          args.commandTemplates?.length ? undefined : 'commandTemplates',
        ].filter(Boolean);
        if (missing.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: [
                  `local_cli capability proposals require ${missing.join(', ')}.`,
                  'Help/manpage output can guide the proposal, but the reviewed manifest must pin executable identity and narrow command templates before runtime projection.',
                ].join('\n'),
              },
            ],
          };
        }
      }
      return submitCapabilityReviewTask(
        'request_permission',
        'Capability proposal',
        {
          permissionKind: 'tool',
          capabilityRequestSource: 'propose_capability',
          capabilityId: args.capabilityId,
          capabilityDisplayName: args.displayName,
          category: args.category,
          risk: args.risk,
          source: args.source,
          sourceRefs: args.sourceRefs ?? [],
          bindings: args.bindings ?? [],
          accountLabel: args.accountLabel,
          can: args.can,
          cannot: args.cannot,
          credentialSource: args.credentialSource,
          executablePath: args.executablePath,
          executableVersion: args.executableVersion,
          executableHash: args.executableHash,
          commandTemplates: args.commandTemplates ?? [],
          authPreflightCommand: args.authPreflightCommand,
          protectedPaths: args.protectedPaths ?? [],
          networkHosts: args.networkHosts ?? [],
          deniedEnvPatterns: [
            ...DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS,
            ...(args.deniedEnvPatterns ?? []),
          ],
          temporaryOnly: false,
          reason: args.reason,
        },
      );
    },
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
            'Use the Control API /v1/agents/:agentId/capabilities or local admin CLI to change agent grants.',
            'Use capability_status for current run access and propose_capability for reviewed additions.',
            'Revocation and account changes update settings.yaml and the Postgres projection; raw tokens are never shown.',
          ].join('\n'),
        },
      ],
    }),
  );
}

async function availableSemanticCapabilities(options: {
  listCapabilities?: SemanticCapabilityProvider;
}): Promise<SemanticCapabilityDefinition[]> {
  const capabilities = await options.listCapabilities?.();
  if (!capabilities?.length) return [];
  return capabilities.filter((capability) => {
    const validation = validateSemanticCapabilityDefinition(capability);
    return validation.ok;
  });
}
