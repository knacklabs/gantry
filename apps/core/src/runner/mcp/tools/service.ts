import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  availableSemanticCapabilities,
  attachedMcpSourceIds,
  chatJid,
  currentConfiguredAllowedTools,
  deploymentMode,
  isAdminMcpToolEnabled,
  memoryUserId,
  memoryDefaultScope,
  providerAccountId,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { SKILL_APPROVAL_WAIT_MS } from './service-constants.js';
import {
  formatMcpApprovalResponse,
  formatSkillProposalResponse,
} from './service-formatters.js';
import { registerAccessRequestTool } from './capabilities.js';
import { registerAdminPermissionTools } from './admin-permissions.js';
import { registerSettingsTools } from './settings.js';
import { makeIpcId } from '../ipc-ids.js';
import type { AdminMcpToolName } from '../../../shared/admin-mcp-tools.js';
import { humanizeTechnicalIdentifier } from '../../../shared/user-visible-messages.js';
import type { SemanticCapabilityDefinition } from '../../../shared/semantic-capabilities.js';
import { browserWrongLaneRequestGuidance } from './service-browser-guidance.js';
import { registerMcpProxyTools } from './mcp-proxy-tools.js';

export function registerServiceTools(server: McpServer): void {
  registerSkillProposalTool(
    server,
    'request_skill_proposal',
    'Request installation or an approved update of an agent-created skill bundle. For a selected skill update, submit the complete replacement package with targetSkillId and expectedContentHash instead of editing managed skill files. Only a configured conversation approver can authorize the change; risky actions still require reviewed capability access.',
  );
  server.tool(
    'pattern_candidate_decision',
    'Record the user decision for a pattern_id from [[PATTERNS_NOTICED]]. Use accept only after the user agrees to a scheduler_job, durable_capability, or memory_update fix; skill fixes go through request_skill_proposal.',
    {
      patternCandidateId: z
        .string()
        .describe('pattern_id from the pattern block'),
      choice: z.enum(['accept', 'not_now', 'dismiss']),
      actionKind: z
        .enum(['scheduler_job', 'durable_capability', 'memory_update'])
        .optional()
        .describe('Required only when choice is accept.'),
    },
    async (args) => {
      const taskId = makeIpcId('pattern-candidate-decision');
      writeIpcFile(TASKS_DIR, {
        type: 'pattern_candidate_decision',
        taskId,
        targetJid: chatJid,
        chatJid,
        memoryUserId,
        authThreadId: threadId,
        providerAccountId,
        payload: {
          patternCandidateId: args.patternCandidateId,
          choice: args.choice,
          actionKind: args.actionKind,
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 10_000);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              response?.message ||
              (response?.ok
                ? 'Pattern decision recorded.'
                : 'Pattern decision was not recorded.'),
          },
        ],
        ...(response?.ok ? {} : { isError: true }),
      };
    },
  );
  server.tool(
    'proactive_surfacing_consent',
    'Record the user explicit decision to keep flagging (enable) or stop flagging (opt_out) proactive patterns for this conversation. Use ONLY after the user explicitly says so this turn.',
    {
      choice: z.enum(['enable', 'opt_out']),
    },
    async (args) => {
      const taskId = makeIpcId('proactive-surfacing-consent');
      writeIpcFile(TASKS_DIR, {
        type: 'proactive_surfacing_consent',
        taskId,
        targetJid: chatJid,
        chatJid,
        memoryUserId,
        authThreadId: threadId,
        payload: {
          choice: args.choice,
          conversationKind: memoryDefaultScope === 'user' ? 'dm' : 'channel',
        },
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 10_000);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              response?.message ||
              (response?.ok
                ? 'Proactive surfacing consent recorded.'
                : 'Proactive surfacing consent was not recorded.'),
          },
        ],
        ...(response?.ok ? {} : { isError: true }),
      };
    },
  );
  registerSettingsTools(server, { isAdminToolEnabled: isAdminMcpToolEnabled });
  registerAdminPermissionTools(server, {
    isAdminToolEnabled: isAdminMcpToolEnabled,
  });

  server.tool(
    'request_skill_install',
    'Request skill source setup for same-conversation admin approval. Approval installs staged files, or runs an approved installer command in host-controlled staging and imports the resulting SKILL.md package. Skill source approval records inventory only; reviewed gantry.skill.json actions become capability candidates. Keep long installs visible with one render_progress line before and after meaningful stages.',
    {
      expectedFiles: z
        .array(z.string())
        .optional()
        .describe('Expected skill package files for review'),
      dependencies: z
        .array(z.string())
        .optional()
        .describe('Declared skill dependencies for review'),
      requiredEnvVars: z
        .array(z.string())
        .optional()
        .describe('Env var names this skill needs from Gantry Credentials'),
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe('Skill package-relative path, such as SKILL.md'),
            content: z.string().describe('UTF-8 file content'),
            contentType: z.string().optional().describe('Optional MIME type'),
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Staged skill files. Must include SKILL.md with name and description frontmatter.',
        ),
      installCommandArgv: z
        .array(z.string())
        .min(1)
        .max(40)
        .optional()
        .describe(
          'Optional installer command argv, such as an npx skills.sh or clawhub installer command. Use only when files are not available.',
        ),
      reason: z.string().describe('Why this skill should be installed'),
    },
    async (args) => {
      const wrongLaneGuidance = browserWrongLaneRequestGuidance(
        'request_skill_install',
        {
          expectedFiles: args.expectedFiles ?? [],
          dependencies: args.dependencies ?? [],
          requiredEnvVars: args.requiredEnvVars ?? [],
          reason: args.reason,
        },
      );
      if (wrongLaneGuidance) return wrongLaneGuidance;
      return submitCapabilityReviewTask(
        'request_skill_install',
        'Skill install',
        {
          expectedFiles: args.expectedFiles ?? [],
          dependencies: args.dependencies ?? [],
          requiredEnvVars: args.requiredEnvVars ?? [],
          files: args.files ?? [],
          installCommandArgv: args.installCommandArgv ?? [],
          reason: args.reason,
        },
      );
    },
  );
  server.tool(
    'request_skill_dependency_install',
    deploymentMode === 'fleet'
      ? 'Request dependencies needed by a reviewed skill source. Approved dependencies are baked into a worker toolchain and take minutes before they are ready; the agent never runs install commands directly. Keep the wait visible with one render_progress line.'
      : 'Request host-installed dependencies needed by a reviewed skill source. Approval records setup inventory; the agent never runs install commands directly. Keep the wait visible with one render_progress line.',
    {
      ecosystem: z
        .enum(['npm', 'brew', 'go', 'uv', 'download'])
        .describe('Dependency ecosystem or install channel'),
      packages: z
        .array(z.string())
        .optional()
        .describe('Package, module, formula, or artifact names to install'),
      commandArgv: z
        .array(z.string())
        .optional()
        .describe('Optional exact install command argv for admin review'),
      skillId: z
        .string()
        .optional()
        .describe('Optional reviewed skill id requiring the dependency'),
      skillName: z
        .string()
        .optional()
        .describe('Optional reviewed skill name requiring the dependency'),
      riskClass: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe('Requested risk classification'),
      reason: z
        .string()
        .describe('Why this dependency is needed for the skill'),
    },
    async (args) =>
      submitCapabilityReviewTask(
        'request_skill_dependency_install',
        'Skill dependency install',
        {
          ecosystem: args.ecosystem,
          packages: args.packages ?? [],
          commandArgv: args.commandArgv ?? [],
          skillId: args.skillId,
          skillName: args.skillName,
          riskClass: args.riskClass,
          reason: args.reason,
        },
      ),
  );
  registerAccessRequestTool(server, submitCapabilityReviewTask, {
    listCapabilities: () => availableSemanticCapabilities,
    isCapabilitySelected: (capabilityId) =>
      currentConfiguredAllowedTools().includes(`capability:${capabilityId}`),
    isToolSelected: (toolName) =>
      currentConfiguredAllowedTools().includes(toolName),
    validateRunCommandFallback: ({ argvPattern }) => {
      const currentAllowedTools = currentConfiguredAllowedTools();
      const selectedMcpCapabilities = availableSemanticCapabilities.filter(
        (capability) =>
          currentAllowedTools.includes(
            `capability:${capability.capabilityId}`,
          ) &&
          capability.implementationBindings.some(
            (binding) =>
              binding.kind === 'mcp_tool' ||
              binding.kind === 'mcp_pattern' ||
              Boolean(binding.mcpTool),
          ),
      );
      const selectedMcpCapabilityIds = selectedMcpCapabilities
        .map((capability) => capability.capabilityId)
        .sort();
      if (selectedMcpCapabilityIds.length === 0) return null;
      const requestedPattern = normalizeMcpServerName(argvPattern);
      const selectedMcpNames = [
        ...new Set(
          selectedMcpCapabilities.flatMap((capability) =>
            mcpCapabilityNames(capability),
          ),
        ),
      ].filter(Boolean);
      const targetsSelectedMcp = selectedMcpNames.some((name) =>
        requestedPattern.includes(name),
      );
      if (!targetsSelectedMcp) return null;
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: [
              'RunCommand/Bash permission is not available as a fallback while MCP access is selected for this run.',
              `Selected MCP capabilities: ${selectedMcpCapabilityIds.join(', ')}`,
              'Use mcp_list_tools to inspect the ready source, then mcp_call_tool for immediate approved actions or async_mcp_call for long-running work.',
            ].join('\n'),
          },
        ],
      };
    },
  });

  server.tool(
    'request_mcp_server',
    'Request third-party MCP source setup for admin review. Approval connects the source; raw MCP tools are inventory and do not become durable capabilities until reviewed.',
    {
      name: z
        .string()
        .describe('Short MCP server name, such as github or linear'),
      transport: z
        .literal('stdio_template')
        .describe('Requested MCP transport'),
      templateId: z
        .enum(['node-script', 'npx-package'])
        .describe('Reviewed stdio template to use'),
      args: z
        .array(z.string())
        .optional()
        .describe(
          'Template arguments. npx-package requires exactly one safe npm package spec.',
        ),
      sandboxProfileId: z
        .string()
        .describe('Reviewed sandbox profile for the stdio server process'),
      requestedToolPatterns: z
        .array(z.string())
        .optional()
        .describe('Expected MCP tool names, without the mcp__server__ prefix'),
      credentialNeeds: z
        .array(z.string())
        .optional()
        .describe('Credential reference names the admin should review'),
      networkHosts: z
        .array(z.string())
        .optional()
        .describe(
          'Outbound hosts the server may reach, as exact host or host:port (no URLs, wildcards, or private/localhost targets)',
        ),
      reason: z.string().describe('Why this capability is needed'),
      docsUrl: z.string().optional().describe('Optional documentation URL'),
    },
    async (args) => {
      const wrongLaneGuidance = browserWrongLaneRequestGuidance(
        'request_mcp_server',
        {
          name: args.name,
          origin: undefined,
          requestedToolPatterns: args.requestedToolPatterns ?? [],
          credentialNeeds: args.credentialNeeds ?? [],
          reason: args.reason,
          docsUrl: args.docsUrl,
        },
      );
      if (wrongLaneGuidance) return wrongLaneGuidance;
      const existingSource = existingMcpSourceForRequest(args.name);
      if (existingSource) {
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `MCP source "${existingSource.serverName}" is already available for this run.`,
                existingSource.selectedCapabilities.length
                  ? `Selected capabilities: ${existingSource.selectedCapabilities.join(', ')}`
                  : 'A matching MCP source is already attached.',
                `Use mcp_list_tools with serverName="${existingSource.serverName}", mcp_describe_tool when schema is needed, then mcp_call_tool with serverName="${existingSource.serverName}" for immediate approved actions or async_mcp_call for long-running work.`,
                'Do not request the same MCP source setup again unless a tool call reports access is missing or denied.',
              ].join('\n'),
            },
          ],
        };
      }
      const taskId = makeIpcId('request-mcp');
      writeIpcFile(TASKS_DIR, {
        type: 'request_mcp_server',
        taskId,
        targetJid: chatJid,
        chatJid,
        memoryUserId,
        authThreadId: threadId,
        payload: {
          name: args.name,
          transport: args.transport,
          templateId: args.templateId,
          args: args.args ?? [],
          sandboxProfileId: args.sandboxProfileId,
          requestedToolPatterns: args.requestedToolPatterns ?? [],
          credentialNeeds: args.credentialNeeds ?? [],
          networkHosts: args.networkHosts ?? [],
          reason: args.reason,
          docsUrl: args.docsUrl,
        },
        timestamp: nowIso(),
      });

      const response = await waitForTaskResponse(
        taskId,
        SKILL_APPROVAL_WAIT_MS,
      );
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                response?.error ||
                'MCP server request was not recorded by the host.',
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatMcpApprovalResponse(
              response.data,
              response.message ||
                'MCP server source connected. Review needed for durable action capabilities.',
            ),
          },
        ],
      };
    },
  );

  registerMcpProxyTools(server);

  server.tool(
    'service_restart',
    'Restart the Gantry service with config validation. Requires selected agent tool grant mcp__gantry__service_restart.',
    {},
    async () => {
      if (!isAdminMcpToolEnabled('service_restart')) {
        return adminToolUnavailable('service_restart');
      }
      const taskId = makeIpcId('service-restart');
      writeIpcFile(TASKS_DIR, {
        type: 'service_restart',
        taskId,
        targetJid: chatJid,
        chatJid,
        timestamp: nowIso(),
      });

      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Service restart requested, but host response timed out.',
            },
          ],
          isError: true,
        };
      }

      if (!response.ok) {
        const lines = [
          response.error || 'Service restart failed.',
          ...(response.details && response.details.length > 0
            ? response.details.map((item) => `- ${item}`)
            : []),
        ];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Service restart completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'register_agent',
    `Register the current chat/channel agent so Gantry can respond to messages there. Requires selected agent tool grant mcp__gantry__register_agent and same-conversation approver approval.

The JID must be the current conversation. The folder name must be channel-prefixed: "{channel}_{conversation-name}" (e.g., "telegram_dev-team", "slack_eng", "discord_ops", "teams_engineering"). Use lowercase with hyphens for the conversation name part.`,
    {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "tg:-1001234567890", "sl:C0123456789", "dc:1234567890", "teams:19:abc@thread.v2")',
        ),
      name: z.string().describe('Display name for the agent'),
      folder: z
        .string()
        .describe('Channel-prefixed folder name (e.g., "discord_ops")'),
      trigger: z.string().describe('Trigger word (e.g., "@Default Agent")'),
      requiresTrigger: z
        .boolean()
        .optional()
        .describe(
          'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
        ),
    },
    async (args) => {
      if (!isAdminMcpToolEnabled('register_agent')) {
        return adminToolUnavailable('register_agent');
      }
      const taskId = makeIpcId('register-agent');
      const data = {
        type: 'register_agent',
        taskId,
        jid: args.jid,
        targetJid: chatJid,
        chatJid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        requiresTrigger: args.requiresTrigger ?? false,
        timestamp: nowIso(),
      };

      writeIpcFile(TASKS_DIR, data);

      const response = await waitForTaskResponse(taskId, 300_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Agent registration requested, but host response timed out.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        const lines = [
          response.error || 'Agent registration failed.',
          ...(response.details && response.details.length > 0
            ? response.details.map((item) => `- ${item}`)
            : []),
        ];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              response.message ||
              `Agent "${args.name}" registered. It will start receiving messages immediately.`,
          },
        ],
      };
    },
  );
}

function mcpCapabilityNames(
  capability: SemanticCapabilityDefinition,
): string[] {
  const names: string[] = [capability.capabilityId];
  const sourceServerName = mcpSourceServerName(capability.source);
  if (sourceServerName) names.push(sourceServerName);
  for (const binding of capability.implementationBindings) {
    if (binding.kind === 'mcp_pattern') {
      if (binding.mcpServer) names.push(binding.mcpServer);
      continue;
    }
    if (binding.kind !== 'mcp_tool' && !binding.mcpTool) continue;
    const match = /^mcp__(.+?)__/.exec(binding.mcpTool ?? '');
    if (match?.[1]) names.push(match[1]);
  }
  return names.map(normalizeMcpServerName).filter(Boolean);
}

function adminToolUnavailable(toolName: AdminMcpToolName): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const fullName = `mcp__gantry__${toolName}`;
  return {
    content: [
      {
        type: 'text',
        text: [
          `${humanizeTechnicalIdentifier(fullName)} is not approved for this agent yet.`,
          `Ask a configured conversation approver to approve ${toolName}, then choose persistent access. Details: ${fullName}.`,
        ].join(' '),
      },
    ],
    isError: true,
  };
}

function existingMcpSourceForRequest(name: string):
  | {
      serverName: string;
      selectedCapabilities: string[];
    }
  | undefined {
  const requestedName = normalizeMcpServerName(name);
  if (!requestedName) return undefined;

  const attachedSourceName = attachedMcpSourceIds
    .map(displayMcpSourceName)
    .find((sourceName) => normalizeMcpServerName(sourceName) === requestedName);
  if (attachedSourceName) {
    return {
      serverName: attachedSourceName,
      selectedCapabilities:
        selectedMcpCapabilitiesForSource(attachedSourceName),
    };
  }

  const selectedCapabilities = selectedMcpCapabilitiesForSource(name);
  if (selectedCapabilities.length > 0) {
    return {
      serverName: name.trim(),
      selectedCapabilities,
    };
  }

  return undefined;
}

function selectedMcpCapabilitiesForSource(serverName: string): string[] {
  const requestedName = normalizeMcpServerName(serverName);
  if (!requestedName) return [];
  const currentAllowedTools = currentConfiguredAllowedTools();
  return availableSemanticCapabilities
    .filter((capability) => {
      if (
        !currentAllowedTools.includes(`capability:${capability.capabilityId}`)
      ) {
        return false;
      }
      const sourceServerName = mcpSourceServerName(capability.source);
      if (normalizeMcpServerName(sourceServerName) === requestedName) {
        return true;
      }
      return capability.implementationBindings.some((binding) => {
        if (binding.kind === 'mcp_pattern') {
          return normalizeMcpServerName(binding.mcpServer) === requestedName;
        }
        if (binding.kind !== 'mcp_tool' && !binding.mcpTool) return false;
        const match = /^mcp__(.+?)__/.exec(binding.mcpTool ?? '');
        return normalizeMcpServerName(match?.[1]) === requestedName;
      });
    })
    .map((capability) => capability.capabilityId)
    .sort();
}

function mcpSourceServerName(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (record.source !== 'mcp') return undefined;
  return typeof record.serverName === 'string' ? record.serverName : undefined;
}

function displayMcpSourceName(sourceId: string): string {
  const normalized = sourceId.trim();
  return normalized.startsWith('mcp:')
    ? normalized.slice('mcp:'.length)
    : normalized;
}

function normalizeMcpServerName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

type CapabilityReviewToolName =
  | 'request_skill_install'
  | 'request_skill_dependency_install'
  | 'request_permission';

async function submitCapabilityReviewTask(
  toolName: CapabilityReviewToolName,
  requestLabel: string,
  payload: Record<string, unknown>,
) {
  const taskId = makeIpcId(toolName.replaceAll('_', '-'));
  writeIpcFile(TASKS_DIR, {
    type: toolName,
    taskId,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
    jobId: process.env.GANTRY_JOB_ID || undefined,
    runId: process.env.GANTRY_JOB_RUN_ID || undefined,
    targetJid: chatJid,
    chatJid,
    authThreadId: threadId,
    providerAccountId,
    payload,
    timestamp: nowIso(),
  });

  const response = await waitForTaskResponse(taskId, SKILL_APPROVAL_WAIT_MS);
  if (!response?.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            response?.error ||
            `${requestLabel} request was not recorded by the host.`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text:
          toolName === 'request_skill_install'
            ? formatSkillProposalResponse(
                response.data,
                response.message || `${requestLabel} approved.`,
                { deploymentMode },
              )
            : response.message ||
              `Approval requested for ${requestLabel}. It will be available after approval.`,
      },
    ],
  };
}

function registerSkillProposalTool(
  server: McpServer,
  toolName: 'request_skill_proposal',
  description: string,
): void {
  const requestLabel = 'Skill proposal';
  server.tool(
    toolName,
    description,
    {
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe('Skill package-relative path, such as SKILL.md'),
            content: z.string().describe('UTF-8 file content'),
            contentType: z.string().optional().describe('Optional MIME type'),
          }),
        )
        .min(1)
        .max(50)
        .describe(
          'Complete skill package. Must include SKILL.md with name and description frontmatter. For an update, include every file that should remain after replacement.',
        ),
      reason: z.string().describe('Why this skill is needed'),
      targetSkillId: z
        .string()
        .optional()
        .describe(
          'Installed skill ID to replace. Use this when updating a selected skill; the declared SKILL.md name must still match it.',
        ),
      expectedContentHash: z
        .string()
        .optional()
        .describe(
          'Current installed content hash shown in selected-skill context. Prevents overwriting a newer update while approval is pending.',
        ),
      patternCandidateId: z
        .string()
        .optional()
        .describe('Optional pattern_id from [[PATTERNS_NOTICED]].'),
    },
    async (args) => {
      const taskId = makeIpcId('request-skill');
      writeIpcFile(TASKS_DIR, {
        type: toolName,
        taskId,
        targetJid: chatJid,
        chatJid,
        memoryUserId,
        authThreadId: threadId,
        providerAccountId,
        payload: {
          files: args.files,
          reason: args.reason,
          targetSkillId: args.targetSkillId,
          expectedContentHash: args.expectedContentHash,
          patternCandidateId: args.patternCandidateId,
        },
        timestamp: nowIso(),
      });

      const response = await waitForTaskResponse(
        taskId,
        SKILL_APPROVAL_WAIT_MS,
      );
      if (!response?.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                response?.error ||
                `${requestLabel} request was not recorded by the host.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatSkillProposalResponse(
              response.data,
              response.message || `${requestLabel} installed.`,
              { deploymentMode },
            ),
          },
        ],
      };
    },
  );
}
