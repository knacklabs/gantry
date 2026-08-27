import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  agentId,
  appId,
  availableSemanticCapabilities,
  chatJid,
  currentConfiguredAllowedTools,
  IPC_AUTH_TOKEN,
  IPC_DIR,
  IPC_RESPONSE_KEY_ID,
  IPC_RESPONSE_VERIFY_KEY,
  jobId,
  jobRunId,
  jobRunLeaseFencingVersion,
  jobRunLeaseToken,
  permissionLane,
  providerAccountId,
  TASKS_DIR,
  threadId,
  workspaceFolder,
} from '../context.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';
import { getPermissionTimeoutMs } from '../../../shared/permission-timeout.js';
import { nowIso } from '../../../shared/time/datetime.js';
import type { SemanticCapabilityDefinition } from '../../../shared/semantic-capabilities.js';
import { registerAccessRequestTool } from './capabilities.js';
import { requestPermissionApprovalViaIpc } from '../../permission-ipc-client.js';
import {
  UNPROJECTED_ACCESS_GRANTED_MESSAGE,
  unprojectedAccessPermissionSuggestions,
  withUnprojectedAccessGrantMetadata,
} from '../../../shared/unprojected-access.js';
import { SKILL_APPROVAL_WAIT_MS } from './service-constants.js';

export function registerServiceAccessRequestTool(server: McpServer): void {
  registerAccessRequestTool(
    server,
    jobId ? submitScheduledAccessReview : submitCapabilityReviewTask,
    {
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
              type: 'text' as const,
              text: [
                'RunCommand/Bash permission is not available as a fallback while MCP access is selected for this run.',
                `Selected MCP capabilities: ${selectedMcpCapabilityIds.join(', ')}`,
                'Use mcp_list_tools to inspect the ready source, then mcp_call_tool for immediate approved actions or async_mcp_call for long-running work.',
              ].join('\n'),
            },
          ],
        };
      },
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

function mcpSourceServerName(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (record.source !== 'mcp') return undefined;
  return typeof record.serverName === 'string' ? record.serverName : undefined;
}

function normalizeMcpServerName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

async function submitCapabilityReviewTask(
  toolName: 'request_permission',
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
          response.message ||
          `Approval requested for ${requestLabel}. It will be available after approval.`,
      },
    ],
  };
}

async function submitScheduledAccessReview(
  toolName: 'request_permission',
  requestLabel: string,
  payload: Record<string, unknown>,
) {
  const semanticCapabilityDefinitions = Object.fromEntries(
    availableSemanticCapabilities.map((capability) => [
      capability.capabilityId,
      capability,
    ]),
  );
  const suggestions = unprojectedAccessPermissionSuggestions(payload, {
    semanticCapabilityDefinitions,
  });
  const decision = await requestPermissionApprovalViaIpc(
    {
      appId: appId ?? 'default',
      agentId: agentId ?? '',
      chatJid,
      providerAccountId,
      jobId: jobId ?? '',
      jobName: process.env.GANTRY_JOB_NAME?.trim() ?? '',
      jobRunId: jobRunId ?? '',
      jobRunLeaseToken: jobRunLeaseToken ?? '',
      jobRunLeaseFencingVersion: jobRunLeaseFencingVersion ?? '',
      ipcAuthToken: IPC_AUTH_TOKEN,
      ipcResponseVerifyKey: IPC_RESPONSE_VERIFY_KEY,
      ipcResponseKeyId: IPC_RESPONSE_KEY_ID,
      agentRunHandle: process.env.GANTRY_AGENT_RUN_HANDLE?.trim() || undefined,
      permissionRequestTimeoutMs: getPermissionTimeoutMs(permissionLane),
      permissionLane,
      permissionMode:
        process.env.GANTRY_PERMISSION_MODE === 'auto' ? 'auto' : 'ask',
      resolveWorkspaceIpcDir: () => IPC_DIR,
    },
    {
      agentFolder: workspaceFolder,
      toolName,
      title: `Approve ${requestLabel.toLowerCase()} request`,
      displayName: requestAccessDisplayName(payload, requestLabel),
      description:
        'Only configured approvers can decide this request. A persistent approval changes future job access.',
      decisionReason: text(payload.reason),
      toolInput: payload,
      ...(suggestions ? { suggestions } : {}),
      ...(Object.keys(semanticCapabilityDefinitions).length > 0
        ? { semanticCapabilityDefinitions }
        : {}),
      ...(threadId ? { threadId } : {}),
    },
  );
  if (
    decision.approved &&
    decision.jobPermissionOutcome === 'approved_unprojected' &&
    decision.unprojectedAccessIdentity
  ) {
    return withUnprojectedAccessGrantMetadata(
      {
        content: [
          {
            type: 'text' as const,
            text: UNPROJECTED_ACCESS_GRANTED_MESSAGE,
          },
        ],
      },
      decision.unprojectedAccessIdentity,
    );
  }
  return {
    content: [
      {
        type: 'text' as const,
        text:
          decision.reason ||
          (decision.approved
            ? 'The access grant was recorded, but its activation state was unavailable.'
            : `${requestLabel} was not approved.`),
      },
    ],
    isError: true,
  };
}

function requestAccessDisplayName(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  return (
    text(payload.capabilityDisplayName) ??
    text(payload.capabilityId) ??
    text(payload.toolName) ??
    text(payload.mcpServerName) ??
    fallback
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.replace(/\s+/g, ' ').trim().slice(0, 300)
    : undefined;
}
