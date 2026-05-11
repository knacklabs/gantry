import type {
  PermissionApprovalDecision,
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
} from '../shared/agent-tool-references.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';

export interface RequestPermissionReview {
  toolName: 'request_permission';
  displayName: string;
}

export function requestPermissionQueuedMessage(
  review: RequestPermissionReview,
): string {
  return `${review.displayName} request sent to this chat for approval. Allow once records a one-shot approval; Always allow can enable the approved rule for this run and future runs.`;
}

export function requestPermissionDescription(): string {
  return 'Only configured approvers can decide this request. Allow once records a one-shot approval; Always allow applies the approved rule to this run and future runs.';
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
  ipcDir?: string;
  runHandle?: string;
  requestId?: string;
  actor?: string;
  conversationId?: string;
  threadId?: string;
  reason?: string;
  allowBroadHostToolGrant?: boolean;
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
    ipcDir: input.ipcDir,
    runHandle: input.runHandle,
    requestId: input.requestId,
    actor: input.actor,
    conversationId: input.conversationId,
    threadId: input.threadId,
    reason: input.reason,
    allowBroadHostToolGrant: input.allowBroadHostToolGrant,
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
  const toolNames = sanitizedStringList(
    Array.isArray(toolInput.toolNames)
      ? toolInput.toolNames
      : [toolInput.toolName],
  );
  if (toolNames.length !== 1) return undefined;
  const ruleContent = strictRuleContent(toolInput.rule);
  if (ruleContent === null) return undefined;
  if (
    isBrowserActionMcpToolRule(toolNames[0]) ||
    isProjectedBrowserMcpToolRule(toolNames[0])
  ) {
    return undefined;
  }
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName: toolNames[0],
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
    },
  ];
}

function strictRuleContent(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 2048 ? trimmed : null;
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
