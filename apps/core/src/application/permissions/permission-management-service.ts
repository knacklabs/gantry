import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  PermissionRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  PermissionDecision,
  PermissionDecisionId,
} from '../../domain/permissions/permissions.js';
import type { AgentToolBinding } from '../../domain/tools/tools.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import {
  adminMcpToolIdForFullName,
  isAdminMcpToolFullName,
  isMyClawMcpWildcardRule,
} from '../../shared/admin-mcp-tools.js';
import { isCanonicalBrowserCapabilityRule } from '../../shared/agent-tool-references.js';
import {
  persistentPermissionToolId,
  parseReadableScopedToolRule,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { appendLiveToolRules } from '../../shared/live-tool-rules.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';

type MirrorAgentToolRulesToSettings = (
  sourceAgentFolder: string,
  rules: string[],
  options?: { appId?: string },
) => Promise<void> | void;

const BROAD_HOST_TOOL_GRANTS = new Set([
  'Agent',
  'Bash',
  'Edit',
  'Read',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
]);

export interface PersistentPermissionGrantInput {
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  updates: PermissionApprovalUpdate[];
  toolRepository: ToolCatalogRepository;
  mirrorAgentToolRulesToSettings: MirrorAgentToolRulesToSettings;
  permissionRepository?: PermissionRepository;
  ipcDir?: string;
  runHandle?: string;
  actor?: string;
  requestId?: string;
  conversationId?: string;
  threadId?: string;
  reason?: string;
  allowBroadHostToolGrant?: boolean;
}

export interface RecordPermissionDecisionInput {
  appId: AppId;
  agentId?: AgentId;
  requestId: string;
  toolName: string;
  decision: PermissionApprovalDecision;
  permissionRepository?: PermissionRepository;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
}

export class PermissionManagementService {
  constructor(
    private readonly clock: { now(): string } = { now: () => nowIso() },
  ) {}

  async applyPersistentToolRuleGrant(
    input: PersistentPermissionGrantInput,
  ): Promise<string[]> {
    const allowedRules = canonicalPersistentPermissionRules(
      permissionUpdateAllowedToolRules(input.updates),
    );
    if (allowedRules.length === 0) return [];
    if (allowedRules.length !== 1) {
      throw new Error('Persistent permission approval must contain one rule');
    }

    const timestamp = this.clock.now();
    const savedBindings: AgentToolBinding[] = [];
    for (const allowedRule of allowedRules) {
      this.validatePersistentRule(allowedRule, {
        allowBroadHostToolGrant: input.allowBroadHostToolGrant === true,
      });
      const adminMcpTool = adminMcpToolFullNameFromRule(allowedRule);
      let toolId = (
        isCanonicalBrowserCapabilityRule(allowedRule)
          ? 'tool:Browser'
          : adminMcpTool
            ? adminMcpToolIdForFullName(adminMcpTool)
            : persistentPermissionToolId(input.appId, allowedRule)
      ) as AgentToolBinding['toolId'];
      if (adminMcpTool || isCanonicalBrowserCapabilityRule(allowedRule)) {
        const existing =
          (await input.toolRepository.getTool(toolId)) ??
          (isCanonicalBrowserCapabilityRule(allowedRule)
            ? (
                await input.toolRepository.listTools({
                  appId: input.appId,
                  statuses: ['active'],
                })
              ).find((tool) => tool.id === toolId)
            : null);
        if (
          !existing ||
          existing.appId !== input.appId ||
          existing.status !== 'active' ||
          !existing.selectable
        ) {
          throw new Error(
            `Tool catalog row ${toolId} is unavailable for persistent approval.`,
          );
        }
      } else {
        const tool = await ensureAgentToolCatalogItem({
          repository: input.toolRepository,
          appId: input.appId,
          reference: allowedRule,
          now: timestamp,
          description:
            'Persistent permission rule approved from permission management.',
          adapterRef: 'permission/request_permission',
        });
        toolId = tool.id as AgentToolBinding['toolId'];
      }
      const binding: AgentToolBinding = {
        id: persistentPermissionBindingId(input.appId, input.agentId, toolId),
        appId: input.appId,
        agentId: input.agentId,
        toolId,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await input.toolRepository.saveAgentToolBinding(binding);
      savedBindings.push(binding);
    }

    try {
      await input.mirrorAgentToolRulesToSettings(
        input.sourceAgentFolder,
        allowedRules,
        { appId: input.appId },
      );
    } catch (err) {
      await Promise.allSettled(
        savedBindings.map((binding) =>
          input.toolRepository.disableAgentToolBinding({
            appId: binding.appId,
            agentId: binding.agentId,
            toolId: binding.toolId,
            updatedAt: this.clock.now(),
          }),
        ),
      );
      await this.recordDecision({
        appId: input.appId,
        agentId: input.agentId,
        requestId:
          input.requestId ??
          `persist-failure:${globalThis.crypto.randomUUID()}`,
        toolName: allowedRules[0] ?? 'unknown',
        decision: {
          approved: false,
          reason: err instanceof Error ? err.message : 'settings write failed',
          decisionClassification: 'user_reject',
        },
        permissionRepository: input.permissionRepository,
        conversationId: input.conversationId,
        threadId: input.threadId,
      });
      throw err;
    }

    appendLiveToolRules({
      ipcDir: input.ipcDir,
      runHandle: input.runHandle,
      rules: allowedRules,
    });

    await this.recordDecision({
      appId: input.appId,
      agentId: input.agentId,
      requestId: input.requestId ?? `persist:${globalThis.crypto.randomUUID()}`,
      toolName: allowedRules[0] ?? 'unknown',
      decision: {
        approved: true,
        mode: 'allow_persistent_rule',
        decidedBy: input.actor,
        reason: input.reason ?? 'Persistent permission rule applied',
        decisionClassification: 'user_permanent',
      },
      permissionRepository: input.permissionRepository,
      conversationId: input.conversationId,
      threadId: input.threadId,
    });
    return allowedRules;
  }

  async recordDecision(input: RecordPermissionDecisionInput): Promise<void> {
    if (!input.permissionRepository) return;
    const now = this.clock.now();
    const effect = input.decision.approved ? 'allow' : 'deny';
    const decision: PermissionDecision = {
      id: `permission-decision:${globalThis.crypto.randomUUID()}` as PermissionDecisionId,
      appId: input.appId,
      ruleIds: [],
      effect,
      reason:
        input.decision.reason ||
        (input.decision.approved ? 'Permission approved' : 'Permission denied'),
      actorContext: {
        requestId: input.requestId,
        origin: 'permission_management_service',
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
        mode: input.decision.mode ?? null,
        classification: input.decision.decisionClassification ?? null,
      },
      actionPreview: input.toolName,
      approverRef: input.decision.decidedBy,
      expiresAt:
        input.decision.approved && input.decision.mode === 'allow_once'
          ? now
          : undefined,
      createdAt: now,
    };
    await input.permissionRepository.saveDecision(decision);
  }

  private validatePersistentRule(
    allowedRule: string,
    options: { allowBroadHostToolGrant: boolean },
  ): void {
    if (isMyClawMcpWildcardRule(allowedRule)) {
      throw new Error(
        'Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.',
      );
    }
    const readableValidation = validateReadableAgentToolRule(allowedRule);
    if (!readableValidation.ok) {
      throw new Error(readableValidation.reason);
    }
    if (!options.allowBroadHostToolGrant && isBroadHostToolRule(allowedRule)) {
      throw new Error(
        'Broad persistent host-tool grants are not approved from chat; request a scoped rule or use an explicit admin/API approval path.',
      );
    }
    const adminMcpTool = adminMcpToolFullNameFromRule(allowedRule);
    if (adminMcpTool && adminMcpTool !== allowedRule) {
      throw new Error(
        'Persistent MyClaw admin MCP tool grants must request the exact tool name without a scoped rule.',
      );
    }
  }
}

function canonicalPersistentPermissionRules(
  rules: readonly string[],
): string[] {
  return [...new Set(rules)];
}

function adminMcpToolFullNameFromRule(allowedRule: string): string | null {
  const trimmed = allowedRule.trim();
  const scoped = parseReadableScopedToolRule(trimmed);
  const toolName = scoped ? scoped.toolName : trimmed;
  return isAdminMcpToolFullName(toolName) ? toolName : null;
}

function isBroadHostToolRule(allowedRule: string): boolean {
  const trimmed = allowedRule.trim();
  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped) {
    const toolName = scoped.toolName;
    const pattern = scoped.scope;
    return (
      BROAD_HOST_TOOL_GRANTS.has(toolName) &&
      (pattern === '*' ||
        pattern === '**' ||
        pattern === '/*' ||
        pattern === '/**')
    );
  }
  return BROAD_HOST_TOOL_GRANTS.has(trimmed);
}

function persistentPermissionBindingId(
  appId: string,
  agentId: string,
  toolId: string,
): AgentToolBinding['id'] {
  const digest = stableSha256Json({ agentId, appId, toolId }).slice(0, 32);
  return `agent-tool-binding:permission:${digest}` as AgentToolBinding['id'];
}
