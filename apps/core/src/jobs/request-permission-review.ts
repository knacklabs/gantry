import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalUpdate,
} from '../domain/types.js';
import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { toTrimmedString } from './ipc-shared.js';
import { permissionUpdateAllowedToolRules } from '../shared/permission-tool-rules.js';
import {
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from '../shared/agent-tool-references.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';
import {
  formatPersistentPermissionRulesForUser,
  isPersistentRequestPermissionRuleAllowed,
} from '../shared/persistent-permission-rules.js';
import {
  buildLocalCliSemanticCapability,
  getBuiltinSemanticCapability,
  semanticCapabilityDefinitionFromToolInput,
  type SemanticCapabilityDefinition,
  validateSemanticCapabilityDefinition,
} from '../shared/semantic-capabilities.js';
import { normalizePersistentBashRuleContent } from '../shared/bash-command-parser.js';
import {
  isValidSemanticCapabilityId,
  semanticCapabilityRule,
} from '../shared/semantic-capability-ids.js';
import { formatApprovalRequestedMessage } from '../shared/user-visible-messages.js';

export interface RequestPermissionReview {
  toolName: 'request_permission';
  displayName: string;
}

export function requestPermissionQueuedMessage(
  review: RequestPermissionReview,
): string {
  return `${formatApprovalRequestedMessage(review.displayName)} Choose one of the options in the approval prompt.`;
}

export function requestPermissionDescription(): string {
  return 'Only configured approvers can decide this setup request. The approval prompt shows whether access is temporary or can be recorded for matching future access.';
}

export function requestPermissionReviewEffect(
  toolInput: Record<string, unknown>,
  fallback: string,
): string {
  return requestPermissionReviewSuggestions(toolInput)
    ? 'persistent_rule_when_always_allowed'
    : fallback;
}

export async function persistRequestPermissionRules(input: {
  deps: Pick<
    IpcDeps,
    | 'getToolRepository'
    | 'getPermissionRepository'
    | 'mirrorAgentToolRulesToSettings'
  >;
  appId?: AppId;
  agentId?: AgentId;
  sourceAgentFolder: string;
  updates: PermissionApprovalUpdate[];
  toolInput?: Record<string, unknown>;
  ipcDir?: string;
  runHandle?: string;
  requestId?: string;
  actor?: string;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
  reason?: string;
}): Promise<string[]> {
  const allowedRules = permissionUpdateAllowedToolRules(input.updates);
  if (allowedRules.length === 0) return [];
  if (!input.appId || !input.agentId) {
    throw new Error(
      'Persistent permission approval requires explicit appId and agentId',
    );
  }
  const repository = input.deps.getToolRepository?.();
  if (!repository) {
    throw new Error(
      'Tool repository unavailable for persistent permission approval',
    );
  }
  const mirrorAgentToolRulesToSettings =
    input.deps.mirrorAgentToolRulesToSettings;
  if (!mirrorAgentToolRulesToSettings) {
    throw new Error(
      'Settings mirror unavailable for persistent permission approval',
    );
  }
  return new PermissionManagementService().applyPersistentToolRuleGrant({
    appId: input.appId,
    agentId: input.agentId,
    sourceAgentFolder: input.sourceAgentFolder,
    updates: input.updates,
    toolRepository: repository,
    mirrorAgentToolRulesToSettings,
    permissionRepository: input.deps.getPermissionRepository?.(),
    semanticCapabilityDefinitions: input.toolInput
      ? semanticCapabilityDefinitionsForToolInput(input.toolInput)
      : undefined,
    ipcDir: input.ipcDir,
    runHandle: input.runHandle,
    requestId: input.requestId,
    actor: input.actor,
    conversationId: input.conversationId,
    // Thread/topic ids route setup prompts; persistent grants bind to the parent conversation.
    runId: input.runId,
    jobId: input.jobId,
    reason: input.reason,
  });
}

export function isPermanentPermissionDecision(
  decision: PermissionApprovalDecision,
): boolean {
  return (
    decision.approved === true &&
    decision.mode === 'allow_persistent_rule' &&
    decision.decisionClassification === 'user_permanent' &&
    (decision.updatedPermissions?.length ?? 0) > 0
  );
}

export function requestPermissionReviewSuggestions(
  toolInput: Record<string, unknown>,
): PermissionApprovalUpdate[] | undefined {
  if (toolInput.temporaryOnly === true) return undefined;
  if (toolInput.permissionKind && toolInput.permissionKind !== 'tool') {
    return undefined;
  }
  const capabilityId = toTrimmedString(toolInput.capabilityId, {
    maxLen: 160,
  });
  const toolNames = sanitizedStringList(
    Array.isArray(toolInput.toolNames)
      ? toolInput.toolNames
      : [toolInput.toolName],
  );
  if (capabilityId && toolNames.length === 0) {
    if (!isValidSemanticCapabilityId(capabilityId)) return undefined;
    const definitions = semanticCapabilityDefinitionsForToolInput(toolInput);
    if (
      !definitions?.[capabilityId] &&
      !getBuiltinSemanticCapability(capabilityId)
    ) {
      return undefined;
    }
    const publicToolRule = semanticCapabilityRule(capabilityId);
    if (
      !isPersistentRequestPermissionRuleAllowed(publicToolRule, {
        semanticCapabilityDefinitions: definitions,
      })
    ) {
      return undefined;
    }
    const [publicToolName, publicRuleContent] =
      splitReadableToolRule(publicToolRule);
    return [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          {
            toolName: publicToolName,
            ...(publicRuleContent ? { ruleContent: publicRuleContent } : {}),
          },
        ],
      },
    ];
  }
  if (toolNames.length !== 1) return undefined;
  const rawToolName = toolNames[0];
  if (rawToolName.includes('(') || rawToolName.includes(')')) return undefined;
  const publicToolName = isProjectedBrowserMcpToolRule(rawToolName)
    ? 'Browser'
    : publicGantryToolNameForSdkTool(rawToolName);
  const ruleContent = canonicalRequestPermissionCommandRule(
    publicToolName,
    strictRuleContent(toolInput.rule),
  );
  if (ruleContent === null) return undefined;
  if (isBrowserActionMcpToolRule(rawToolName)) {
    return undefined;
  }
  const publicToolRule =
    publicToolName === RUN_COMMAND_TOOL_NAME && ruleContent
      ? `${publicToolName}(${ruleContent})`
      : publicToolName;
  if (!validateReadableAgentToolRule(publicToolRule).ok) {
    return undefined;
  }
  if (!isPersistentRequestPermissionRuleAllowed(publicToolRule)) {
    return undefined;
  }
  const [suggestedToolName, publicRuleContent] =
    splitReadableToolRule(publicToolRule);
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName: suggestedToolName,
          ...(publicRuleContent ? { ruleContent: publicRuleContent } : {}),
        },
      ],
    },
  ];
}

export function requestPermissionSetupDecisionOptions(
  toolInput: Record<string, unknown>,
): PermissionApprovalDecisionMode[] {
  const suggestions = requestPermissionReviewSuggestions(toolInput);
  return permissionUpdateAllowedToolRules(suggestions).length > 0
    ? ['allow_once', 'allow_persistent_rule', 'cancel']
    : ['allow_once', 'cancel'];
}

export { formatPersistentPermissionRulesForUser };

export function validateRequestPermissionSemanticCapability(
  toolInput: Record<string, unknown>,
): string | undefined {
  const capabilityId = toTrimmedString(toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  if (!isValidSemanticCapabilityId(capabilityId)) {
    return 'Capability id must use lowercase dot-separated words such as google.sheets.write.';
  }
  const definitions = semanticCapabilityDefinitionsForToolInput(toolInput);
  const definition = definitions?.[capabilityId];
  if (!definition) return undefined;
  const validation = validateSemanticCapabilityDefinition(definition);
  return validation.ok ? undefined : validation.reason;
}

export function semanticCapabilityDefinitionsForToolInput(
  toolInput: Record<string, unknown>,
): Record<string, SemanticCapabilityDefinition> | undefined {
  const capabilityId = toTrimmedString(toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  if (capabilityId.startsWith('skill.')) return undefined;
  const explicitDefinition = semanticCapabilityDefinitionFromToolInput(
    toolInput,
    capabilityId,
  );
  if (explicitDefinition?.credentialSource === 'local_cli') {
    return { [explicitDefinition.capabilityId]: explicitDefinition };
  }
  if (toolInput.credentialSource !== 'local_cli') return undefined;
  const commandTemplates = sanitizedStringList(
    Array.isArray(toolInput.commandTemplates)
      ? toolInput.commandTemplates
      : [toolInput.commandTemplate],
  );
  const capability = buildLocalCliSemanticCapability({
    capabilityId,
    displayName:
      toTrimmedString(toolInput.capabilityDisplayName, { maxLen: 200 }) ||
      toTrimmedString(toolInput.displayName, { maxLen: 200 }) ||
      capabilityId,
    category:
      toTrimmedString(toolInput.category, { maxLen: 120 }) || 'Local CLI',
    risk:
      toolInput.risk === 'read' ||
      toolInput.risk === 'write' ||
      toolInput.risk === 'admin'
        ? toolInput.risk
        : 'read',
    accountLabel: toTrimmedString(toolInput.accountLabel, { maxLen: 200 }),
    can:
      toTrimmedString(toolInput.can, { maxLen: 1000 }) ||
      'Review the proposed local CLI command templates and account context.',
    cannot:
      toTrimmedString(toolInput.cannot, { maxLen: 1000 }) ||
      'Run commands outside the reviewed templates, receive raw tokens, or write credential stores.',
    executablePath:
      toTrimmedString(toolInput.executablePath, { maxLen: 2048 }) || '',
    executableVersion: toTrimmedString(toolInput.executableVersion, {
      maxLen: 200,
    }),
    executableHash: toTrimmedString(toolInput.executableHash, {
      maxLen: 200,
    }),
    commandTemplates,
    authPreflightCommand: toTrimmedString(toolInput.authPreflightCommand, {
      maxLen: 2048,
    }),
    protectedPaths: sanitizedStringList(
      Array.isArray(toolInput.protectedPaths) ? toolInput.protectedPaths : [],
    ),
    networkHosts: sanitizedStringList(
      Array.isArray(toolInput.networkHosts)
        ? toolInput.networkHosts
        : Array.isArray(toolInput.network_hosts)
          ? toolInput.network_hosts
          : [],
    ),
    deniedEnvPatterns: sanitizedStringList(
      Array.isArray(toolInput.deniedEnvPatterns)
        ? toolInput.deniedEnvPatterns
        : [],
    ),
  });
  return { [capability.capabilityId]: capability };
}

function strictRuleContent(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 2048 ? trimmed : null;
}

function canonicalRequestPermissionCommandRule(
  toolName: string,
  ruleContent: string | undefined | null,
): string | undefined | null {
  if (toolName !== RUN_COMMAND_TOOL_NAME || !ruleContent) return ruleContent;
  return normalizePersistentBashRuleContent(ruleContent);
}

function splitReadableToolRule(rule: string): [string, string | undefined] {
  const open = rule.indexOf('(');
  if (open <= 0 || !rule.endsWith(')')) return [rule, undefined];
  return [rule.slice(0, open), rule.slice(open + 1, -1)];
}

function sanitizedStringList(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .slice(0, 50)
        .map((item) => toTrimmedString(item, { maxLen: 512 }))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}
