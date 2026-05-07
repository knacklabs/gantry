import { createHash } from 'node:crypto';

import type {
  PermissionApprovalDecision,
  PermissionApprovalUpdate,
} from '../domain/types.js';
import type { AgentToolBinding } from '../domain/tools/tools.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { toTrimmedString } from './ipc-shared.js';
import {
  adminMcpToolIdForFullName,
  isAdminMcpToolFullName,
  isMyClawMcpWildcardRule,
} from '../shared/admin-mcp-tools.js';
import { appendLiveToolRules } from '../shared/live-tool-rules.js';
import { permissionUpdateAllowedToolRules } from '../shared/permission-tool-rules.js';
import { ensureAgentToolCatalogItem } from '../domain/tools/agent-tool-catalog-references.js';
import { persistentPermissionToolId } from '../shared/agent-tool-references.js';

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
  deps: Pick<IpcDeps, 'getToolRepository' | 'mirrorAgentToolRulesToSettings'>;
  sourceAgentFolder: string;
  updates: PermissionApprovalUpdate[];
  ipcDir?: string;
  runHandle?: string;
}): Promise<string[]> {
  const allowedRules = permissionUpdateAllowedToolRules(input.updates);
  if (allowedRules.length === 0) return [];
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
  if (allowedRules.length !== 1) {
    throw new Error('Persistent permission approval must contain one rule');
  }
  const appId = DEFAULT_MEMORY_APP_ID as never;
  const agentId = memoryAgentIdForGroupFolder(input.sourceAgentFolder) as never;
  const timestamp = new Date().toISOString();
  const savedBindings: AgentToolBinding[] = [];
  for (const allowedRule of allowedRules) {
    if (isMyClawMcpWildcardRule(allowedRule)) {
      throw new Error(
        'Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.',
      );
    }
    const adminMcpTool = adminMcpToolFullNameFromRule(allowedRule);
    if (adminMcpTool && adminMcpTool !== allowedRule) {
      throw new Error(
        'Persistent MyClaw admin MCP tool grants must request the exact tool name without a scoped rule.',
      );
    }
    const toolId = (
      adminMcpTool
        ? adminMcpToolIdForFullName(adminMcpTool)
        : persistentPermissionToolId(allowedRule)
    ) as AgentToolBinding['toolId'];
    if (adminMcpTool) {
      const existing = await repository.getTool(toolId);
      if (!existing || existing.status !== 'active' || !existing.selectable) {
        throw new Error(
          `Tool catalog row ${toolId} is unavailable for persistent approval.`,
        );
      }
    } else {
      await ensureAgentToolCatalogItem({
        repository,
        appId,
        reference: allowedRule,
        now: timestamp,
        description:
          'Persistent permission rule approved from request_permission.',
        adapterRef: 'permission/request_permission',
      });
    }
    const binding: AgentToolBinding = {
      id: persistentPermissionBindingId(appId, agentId, toolId),
      appId,
      agentId,
      toolId,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await repository.saveAgentToolBinding(binding);
    savedBindings.push(binding);
  }
  try {
    await mirrorAgentToolRulesToSettings(input.sourceAgentFolder, allowedRules);
  } catch (err) {
    await Promise.allSettled(
      savedBindings.map((binding) =>
        repository.disableAgentToolBinding({
          appId: binding.appId,
          agentId: binding.agentId,
          toolId: binding.toolId,
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
    throw err;
  }
  appendLiveToolRules({
    ipcDir: input.ipcDir,
    runHandle: input.runHandle,
    rules: allowedRules,
  });
  return allowedRules;
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

function adminMcpToolFullNameFromRule(allowedRule: string): string | null {
  const trimmed = allowedRule.trim();
  const toolName = trimmed.includes('(')
    ? trimmed.slice(0, trimmed.indexOf('('))
    : trimmed;
  return isAdminMcpToolFullName(toolName) ? toolName : null;
}

function strictRuleContent(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 2048 ? trimmed : null;
}

function persistentPermissionBindingId(
  appId: string,
  agentId: string,
  toolId: string,
): AgentToolBinding['id'] {
  const digest = createHash('sha256')
    .update(`${appId}\0${agentId}\0${toolId}`)
    .digest('base64url')
    .slice(0, 32);
  return `agent-tool-binding:permission:${digest}` as AgentToolBinding['id'];
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
