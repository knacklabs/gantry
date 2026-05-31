import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  type SemanticCapabilityDefinition,
  validateSemanticCapabilityDefinition,
} from '../../../shared/semantic-capabilities.js';
import { SOURCE_INVENTORY_AUTHORITY_GUIDANCE } from '../../../shared/capability-guidance.js';
import {
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from '../../../shared/agent-tool-references.js';
import { validateDurableAccessRule } from '../../../shared/durable-access-policy.js';

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

const CapabilityTargetSchema = z.object({
  kind: z.literal('capability'),
  id: z
    .string()
    .min(1)
    .describe('Reviewed semantic capability id, such as acme.invoices.read'),
});

const RunCommandTargetSchema = z.object({
  kind: z.literal('run_command'),
  argvPattern: z
    .string()
    .min(1)
    .describe(
      'Scoped command pattern for a persistent RunCommand fallback, such as "npm test *" or "git status". Never broad "cli *".',
    ),
});

export function registerAccessRequestTool(
  server: McpServer,
  submitCapabilityReviewTask: CapabilityReviewSubmitter,
  options: { listCapabilities?: SemanticCapabilityProvider } = {},
): void {
  server.tool(
    'request_access',
    [
      'Request agent access for review. One tool for every access request.',
      'target.kind=capability requests an already-reviewed semantic capability by id.',
      'target.kind=run_command requests a scoped RunCommand fallback such as "npm test *".',
      'Set temporaryOnly=true for one-off transient access; leave it false for durable grants.',
      'Source install/connect stays separate: use request_skill_install/request_skill_proposal for skills and request_mcp_server for third-party MCP sources.',
    ].join(' '),
    {
      target: z.discriminatedUnion('kind', [
        CapabilityTargetSchema,
        RunCommandTargetSchema,
      ]),
      reason: z.string().describe('Why this access is needed'),
      temporaryOnly: z
        .boolean()
        .optional()
        .describe('One-off/transient access for the current action only'),
      broadAccess: z
        .boolean()
        .optional()
        .describe('Reviewer signal that the requested access is broad'),
      riskClass: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe(
          'Requested risk classification. Broad shell, edit/write, network, credential, service, or wildcard MCP access should be high or critical.',
        ),
    },
    async (args) => {
      const { target } = args;
      switch (target.kind) {
        case 'capability': {
          const approved = (await availableSemanticCapabilities(options)).find(
            (candidate) => candidate.capabilityId === target.id,
          );
          if (!approved) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: [
                    `No reviewed capability matches id "${target.id}".`,
                    'Use the Agent Access summary in your run context to find a valid capability id, or request source install/connect if the capability is missing.',
                    SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
                  ].join('\n'),
                },
              ],
            };
          }
          return submitCapabilityReviewTask(
            'request_permission',
            'Capability',
            {
              permissionKind: 'tool',
              capabilityRequestSource: 'request_access',
              capabilityId: approved.capabilityId,
              capabilityDisplayName: approved.displayName,
              accountLabel: approved.accountLabel,
              can: approved.can,
              cannot: approved.cannot,
              credentialSource: approved.credentialSource,
              risk: approved.risk,
              temporaryOnly: args.temporaryOnly ?? false,
              broadAccess: args.broadAccess,
              riskClass: args.riskClass,
              reason: args.reason,
            },
          );
        }
        case 'run_command': {
          const rule = `${RUN_COMMAND_TOOL_NAME}(${target.argvPattern})`;
          const validation = validateReadableAgentToolRule(rule);
          if (!validation.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid run_command access request: ${validation.reason}`,
                },
              ],
            };
          }
          if (args.temporaryOnly !== true) {
            const durableValidation = validateDurableAccessRule(rule);
            if (!durableValidation.ok) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `Invalid durable run_command access request: ${durableValidation.reason}`,
                  },
                ],
              };
            }
          }
          return submitCapabilityReviewTask(
            'request_permission',
            'Permission',
            {
              permissionKind: 'tool',
              capabilityRequestSource: 'request_access',
              toolName: RUN_COMMAND_TOOL_NAME,
              rule: target.argvPattern,
              temporaryOnly: args.temporaryOnly ?? false,
              broadAccess: args.broadAccess,
              riskClass: args.riskClass,
              reason: args.reason,
            },
          );
        }
      }
    },
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
