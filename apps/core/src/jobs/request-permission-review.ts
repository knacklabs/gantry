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
import {
  PermissionManagementService,
  semanticCapabilityDefinitionsFromToolCatalog,
} from '../application/permissions/permission-management-service.js';
import { skillActionDefinitionsForAgent } from '../application/agents/agent-capability-skill-actions.js';
import {
  formatDurableAccessRulesForUser,
  isDurableAccessRuleAllowed,
} from '../shared/durable-access-policy.js';
import {
  expandSemanticCapabilityPermissionRules,
  type SemanticCapabilityDefinition,
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

interface RequestPermissionReviewOptions {
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
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

export function pendingAccessTargetSummary(review: {
  toolName: string;
  requestKind: string;
  toolInput: Record<string, unknown>;
}): Record<string, string> {
  const summary: Record<string, string> = {
    requestTool: review.toolName,
    requestKind: review.requestKind,
  };
  const effect = toTrimmedString(review.toolInput.effect, { maxLen: 120 });
  if (effect) summary.effect = effect;
  const activation = toTrimmedString(review.toolInput.activation, {
    maxLen: 120,
  });
  if (activation) summary.activation = activation;
  return summary;
}

export async function persistRequestPermissionRules(input: {
  deps: Pick<
    IpcDeps,
    | 'getToolRepository'
    | 'getMcpServerRepository'
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
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
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
    mcpServerRepository: input.deps.getMcpServerRepository?.(),
    mirrorAgentToolRulesToSettings,
    permissionRepository: input.deps.getPermissionRepository?.(),
    semanticCapabilityDefinitions:
      input.semanticCapabilityDefinitions ??
      (input.toolInput
        ? semanticCapabilityDefinitionsForToolInput(input.toolInput)
        : undefined),
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
  options: RequestPermissionReviewOptions = {},
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
    if (toolInput.capabilityRequestSource !== 'request_access')
      return undefined;
    const publicToolRule = semanticCapabilityRule(capabilityId);
    if (
      options.semanticCapabilityDefinitions &&
      !isDurableAccessRuleAllowed(publicToolRule, {
        semanticCapabilityDefinitions: options.semanticCapabilityDefinitions,
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
  if (!isDurableAccessRuleAllowed(publicToolRule)) {
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

export function requestPermissionTransientLiveRules(
  toolInput: Record<string, unknown>,
): string[] {
  if (toolInput.temporaryOnly !== true) return [];
  if (toolInput.permissionKind && toolInput.permissionKind !== 'tool')
    return [];
  const capabilityId = toTrimmedString(toolInput.capabilityId, {
    maxLen: 160,
  });
  if (capabilityId) return [];
  const toolNames = sanitizedStringList(
    Array.isArray(toolInput.toolNames)
      ? toolInput.toolNames
      : [toolInput.toolName],
  );
  if (toolNames.length !== 1) return [];
  const publicToolName = publicGantryToolNameForSdkTool(toolNames[0]);
  if (publicToolName !== RUN_COMMAND_TOOL_NAME) return [];
  const ruleContent = strictRuleContent(toolInput.rule);
  if (!ruleContent) return [];
  const rule = `${RUN_COMMAND_TOOL_NAME}(${ruleContent})`;
  return validateReadableAgentToolRule(rule).ok ? [rule] : [];
}

export async function resolveTrustedSemanticCapabilityDefinitions(input: {
  deps: Pick<IpcDeps, 'getToolRepository' | 'getSkillRepository'>;
  appId: AppId;
  agentId: AgentId;
}): Promise<Record<string, SemanticCapabilityDefinition> | undefined> {
  const definitions: Record<string, SemanticCapabilityDefinition> = {};
  const toolRepository = input.deps.getToolRepository?.();
  if (toolRepository && typeof toolRepository.listTools === 'function') {
    const activeTools = await toolRepository.listTools({
      appId: input.appId,
      statuses: ['active'],
    });
    const catalog = semanticCapabilityDefinitionsFromToolCatalog(activeTools);
    if (catalog) Object.assign(definitions, catalog);
  }
  const skillRepository = input.deps.getSkillRepository?.();
  if (skillRepository) {
    Object.assign(
      definitions,
      await skillActionDefinitionsForAgent({
        appId: input.appId,
        agentId: input.agentId,
        skillRepository,
      }),
    );
  }
  return Object.keys(definitions).length > 0 ? definitions : undefined;
}

export function requestPermissionOnceLiveRules(
  toolInput: Record<string, unknown>,
  definitions: Record<string, SemanticCapabilityDefinition> | undefined,
): string[] {
  const capabilityId = toTrimmedString(toolInput.capabilityId, { maxLen: 160 });
  if (capabilityId && definitions?.[capabilityId]) {
    return expandSemanticCapabilityPermissionRules({
      rules: [semanticCapabilityRule(capabilityId)],
      definitions,
    });
  }
  return requestPermissionTransientLiveRules(toolInput);
}

export function requestPermissionSetupDecisionOptions(
  toolInput: Record<string, unknown>,
  options: RequestPermissionReviewOptions = {},
): PermissionApprovalDecisionMode[] {
  const suggestions = requestPermissionReviewSuggestions(toolInput, options);
  return permissionUpdateAllowedToolRules(suggestions).length > 0
    ? ['allow_once', 'allow_persistent_rule', 'cancel']
    : ['allow_once', 'cancel'];
}

export { formatDurableAccessRulesForUser };

export function validateRequestPermissionSemanticCapability(
  toolInput: Record<string, unknown>,
): string | undefined {
  const capabilityId = toTrimmedString(toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  if (!isValidSemanticCapabilityId(capabilityId)) {
    return 'Capability id must use lowercase dot-separated words such as app.resource.action.';
  }
  return undefined;
}

export function semanticCapabilityDefinitionsForToolInput(
  _toolInput: Record<string, unknown>,
): Record<string, SemanticCapabilityDefinition> | undefined {
  return undefined;
}

export function validateRequestPermissionCapabilityProposal(input: {
  capabilityId?: string;
  toolNames: readonly string[];
  capabilityRequestSource?: unknown;
  toolInput: Record<string, unknown>;
}): string | undefined {
  if (!input.capabilityId || input.toolNames.length > 0) return undefined;
  if (input.capabilityRequestSource !== 'request_access') {
    return 'Capability access must use request_access target.kind=capability, not direct request_permission.';
  }
  if (
    Object.prototype.hasOwnProperty.call(
      input.toolInput,
      'semanticCapabilityDefinition',
    ) ||
    Object.prototype.hasOwnProperty.call(
      input.toolInput,
      'capabilityDefinition',
    )
  ) {
    return 'Capability definitions are host-owned catalog metadata and cannot be supplied in request_permission input.';
  }
  return undefined;
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
