import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerRepository,
  PermissionRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  PermissionDecision,
  PermissionDecisionId,
} from '../../domain/permissions/permissions.js';
import type {
  AgentToolBinding,
  ToolCatalogItem,
  ToolId,
} from '../../domain/tools/tools.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import { skillActionSource } from '../../domain/skills/skill-action-permissions.js';
import {
  expandSemanticCapabilityPermissionRules,
  semanticCapabilityRuntimeRules,
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import {
  ensureMcpSourceBindingsForRules,
  rollbackAppliedMcpSourceBindings,
  type AppliedMcpSourceBinding,
} from './mcp-capability-source-bindings.js';
import {
  adminMcpToolIdForFullName,
  isAdminMcpToolFullName,
} from '../../shared/admin-mcp-tools.js';
import {
  displayToolReference,
  isCanonicalBrowserCapabilityRule,
  parseReadableScopedToolRule,
  persistentPermissionToolId,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import {
  appendLiveToolRules,
  removeLiveToolRules,
} from '../../shared/live-tool-rules.js';
import {
  durableAccessRuleAuditPreview,
  validateDurableAccessRule,
} from '../../shared/durable-access-policy.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import { canonicalizeDurableSkillActionToolRule } from '../../shared/skill-action-capability-rules.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';

type MirrorAgentToolRulesToSettings = (
  sourceAgentFolder: string,
  rules: string[],
  options?: { appId?: string; mode?: 'add' | 'remove' },
) => Promise<void> | void;

export interface PersistentPermissionGrantInput {
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  updates: PermissionApprovalUpdate[];
  toolRepository: ToolCatalogRepository;
  mcpServerRepository?: McpServerRepository;
  mirrorAgentToolRulesToSettings: MirrorAgentToolRulesToSettings;
  permissionRepository?: PermissionRepository;
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  ipcDir?: string;
  runHandle?: string;
  actor?: string;
  requestId?: string;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
  reason?: string;
}

export interface PersistentPermissionRevokeInput {
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  toolRepository: ToolCatalogRepository;
  mirrorAgentToolRulesToSettings: MirrorAgentToolRulesToSettings;
  permissionRepository?: PermissionRepository;
  ipcDir?: string;
  runHandle?: string;
  actor?: string;
  requestId?: string;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
  reason?: string;
  toolName?: string;
  toolId?: string;
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
  toolId?: string;
  auditMetadata?: Record<string, unknown>;
}

export class PermissionManagementService {
  constructor(
    private readonly clock: { now(): string } = { now: () => nowIso() },
  ) {}

  async applyPersistentToolRuleGrant(
    input: PersistentPermissionGrantInput,
  ): Promise<string[]> {
    const activeCatalogTools = await input.toolRepository.listTools({
      appId: input.appId,
      statuses: ['active'],
    });
    const catalogSemanticCapabilityDefinitions =
      semanticCapabilityDefinitionsFromToolCatalog(activeCatalogTools);
    assertNoRequestCapabilityDefinitionConflicts({
      catalogDefinitions: catalogSemanticCapabilityDefinitions,
      requestDefinitions: input.semanticCapabilityDefinitions,
    });
    const trustedSemanticCapabilityDefinitions =
      mergeSemanticCapabilityDefinitions(
        input.semanticCapabilityDefinitions,
        catalogSemanticCapabilityDefinitions,
      );
    const allowedRules = canonicalPersistentPermissionRules(
      permissionUpdateAllowedToolRules(input.updates),
      trustedSemanticCapabilityDefinitions,
    );
    if (allowedRules.length === 0) return [];
    for (const allowedRule of allowedRules) {
      this.validatePersistentRule(allowedRule, {
        semanticCapabilityDefinitions: trustedSemanticCapabilityDefinitions,
      });
    }

    const timestamp = this.clock.now();
    const savedBindings: AgentToolBinding[] = [];
    const activatedMcpBindings: AppliedMcpSourceBinding[] = [];
    const grantedToolIds: string[] = [];
    const previouslyActiveToolIds = new Set(
      (typeof input.toolRepository.listAgentToolBindings === 'function'
        ? await input.toolRepository.listAgentToolBindings({
            appId: input.appId,
            agentId: input.agentId,
          })
        : []
      )
        .filter((binding) => binding.status === 'active')
        .map((binding) => binding.toolId),
    );
    try {
      for (const allowedRule of allowedRules) {
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
            semanticCapabilityDefinitions: trustedSemanticCapabilityDefinitions,
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
        grantedToolIds.push(String(binding.toolId));
        if (!previouslyActiveToolIds.has(binding.toolId)) {
          savedBindings.push(binding);
        }
      }
      activatedMcpBindings.push(
        ...(await ensureMcpSourceBindingsForRules({
          appId: input.appId,
          agentId: input.agentId,
          mcpServerRepository: input.mcpServerRepository,
          rules: allowedRules,
          semanticCapabilityDefinitions: trustedSemanticCapabilityDefinitions,
          timestamp,
        })),
      );
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
      await rollbackAppliedMcpSourceBindings({
        appId: input.appId,
        agentId: input.agentId,
        mcpServerRepository: input.mcpServerRepository,
        applied: activatedMcpBindings,
        timestamp: this.clock.now(),
      });
      await this.recordDecision({
        appId: input.appId,
        agentId: input.agentId,
        requestId:
          input.requestId ??
          `persist-failure:${globalThis.crypto.randomUUID()}`,
        toolName: persistentPermissionRuleAuditPreviewForRules(allowedRules),
        decision: {
          approved: false,
          reason: err instanceof Error ? err.message : 'settings write failed',
          decisionClassification: 'user_reject',
        },
        permissionRepository: input.permissionRepository,
        conversationId: input.conversationId,
        threadId: input.threadId,
        runId: input.runId,
        jobId: input.jobId,
        toolId: grantedToolIds[0],
        auditMetadata: persistentPermissionGrantAuditMetadata({
          rules: allowedRules,
          semanticCapabilityDefinitions: trustedSemanticCapabilityDefinitions,
        }),
      });
      throw err;
    }

    appendLiveToolRules({
      ipcDir: input.ipcDir,
      runHandle: input.runHandle,
      rules: expandSemanticCapabilityPermissionRules({
        rules: allowedRules,
        definitions: trustedSemanticCapabilityDefinitions,
      }),
    });

    await this.recordDecision({
      appId: input.appId,
      agentId: input.agentId,
      requestId: input.requestId ?? `persist:${globalThis.crypto.randomUUID()}`,
      toolName: persistentPermissionRuleAuditPreviewForRules(allowedRules),
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
      runId: input.runId,
      jobId: input.jobId,
      toolId: grantedToolIds[0],
      auditMetadata: persistentPermissionGrantAuditMetadata({
        rules: allowedRules,
        semanticCapabilityDefinitions: trustedSemanticCapabilityDefinitions,
      }),
    });
    return allowedRules;
  }

  async revokePersistentToolRuleGrant(
    input: PersistentPermissionRevokeInput,
  ): Promise<{ revokedRule: string; toolId: string }> {
    const activeBindings = (
      typeof input.toolRepository.listAgentToolBindings === 'function'
        ? await input.toolRepository.listAgentToolBindings({
            appId: input.appId,
            agentId: input.agentId,
          })
        : []
    ).filter((binding) => binding.status === 'active');
    const activeTools = await input.toolRepository.listTools({
      appId: input.appId,
      statuses: ['active'],
    });
    const toolById = new Map(activeTools.map((tool) => [tool.id, tool]));
    const target = resolveRevocationTarget({
      appId: input.appId,
      bindings: activeBindings,
      toolById,
      toolName: input.toolName,
      toolId: input.toolId,
    });
    const liveRules = expandedRevocationLiveRules(target);
    const timestamp = this.clock.now();
    try {
      await input.toolRepository.disableAgentToolBinding({
        appId: input.appId,
        agentId: input.agentId,
        toolId: target.binding.toolId,
        updatedAt: timestamp,
      });
      await input.mirrorAgentToolRulesToSettings(
        input.sourceAgentFolder,
        [target.rule],
        { appId: input.appId, mode: 'remove' },
      );
      removeLiveToolRules({
        ipcDir: input.ipcDir,
        runHandle: input.runHandle,
        rules: liveRules,
      });
    } catch (err) {
      await Promise.allSettled([
        input.toolRepository.saveAgentToolBinding({
          ...target.binding,
          status: 'active',
          updatedAt: this.clock.now() as never,
        }),
        Promise.resolve(
          input.mirrorAgentToolRulesToSettings(
            input.sourceAgentFolder,
            [target.rule],
            { appId: input.appId },
          ),
        ),
        Promise.resolve(
          appendLiveToolRules({
            ipcDir: input.ipcDir,
            runHandle: input.runHandle,
            rules: liveRules,
          }),
        ),
      ]);
      await this.recordDecision({
        appId: input.appId,
        agentId: input.agentId,
        requestId:
          input.requestId ?? `revoke-failure:${globalThis.crypto.randomUUID()}`,
        toolName: `revoke ${durableAccessRuleAuditPreview(target.rule)}`,
        decision: {
          approved: false,
          reason:
            err instanceof Error ? err.message : 'permission revoke failed',
          decisionClassification: 'user_reject',
        },
        permissionRepository: input.permissionRepository,
        conversationId: input.conversationId,
        threadId: input.threadId,
        runId: input.runId,
        jobId: input.jobId,
        toolId: target.binding.toolId,
      });
      throw err;
    }

    await this.recordDecision({
      appId: input.appId,
      agentId: input.agentId,
      requestId: input.requestId ?? `revoke:${globalThis.crypto.randomUUID()}`,
      toolName: `revoke ${durableAccessRuleAuditPreview(target.rule)}`,
      decision: {
        approved: false,
        decidedBy: input.actor,
        reason: input.reason ?? 'Persistent permission rule revoked',
        decisionClassification: 'user_reject',
      },
      permissionRepository: input.permissionRepository,
      conversationId: input.conversationId,
      threadId: input.threadId,
      runId: input.runId,
      jobId: input.jobId,
      toolId: target.binding.toolId,
    });
    return { revokedRule: target.rule, toolId: target.binding.toolId };
  }

  async recordDecision(input: RecordPermissionDecisionInput): Promise<void> {
    if (!input.permissionRepository) return;
    const now = this.clock.now();
    const effect = input.decision.approved ? 'allow' : 'deny';
    const decision: PermissionDecision = {
      id: `permission-decision:${globalThis.crypto.randomUUID()}` as PermissionDecisionId,
      appId: input.appId,
      ruleIds: [],
      runId: input.runId as never,
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
        ...(input.auditMetadata ?? {}),
      },
      actionPreview: input.toolName,
      toolId: input.toolId as never,
      approverRef: input.decision.decidedBy,
      expiresAt: permissionDecisionExpiresAt(input.decision, now),
      createdAt: now,
    };
    await input.permissionRepository.saveDecision(decision);
  }

  private validatePersistentRule(
    allowedRule: string,
    options: {
      semanticCapabilityDefinitions?: Record<
        string,
        SemanticCapabilityDefinition
      >;
    },
  ): void {
    const validation = validateDurableAccessRule(allowedRule, {
      ...options,
      allowUnknownSemanticCapability: false,
    });
    if (!validation.ok) throw new Error(validation.reason);
    const adminMcpTool = adminMcpToolFullNameFromRule(allowedRule);
    if (adminMcpTool && adminMcpTool !== allowedRule) {
      throw new Error(
        'Persistent Gantry admin MCP tool grants must request the exact tool name without a scoped rule.',
      );
    }
  }
}

function permissionDecisionExpiresAt(
  decision: PermissionApprovalDecision,
  now: string,
): string | undefined {
  if (!decision.approved) return undefined;
  if (decision.mode === 'allow_once') return now;
  if (
    decision.mode === 'allow_timed_grant' &&
    typeof decision.timedGrantExpiresAtMs === 'number' &&
    Number.isFinite(decision.timedGrantExpiresAtMs)
  ) {
    return new Date(decision.timedGrantExpiresAtMs).toISOString();
  }
  return undefined;
}

function canonicalPersistentPermissionRules(
  rules: readonly string[],
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>,
): string[] {
  return [
    ...new Set(
      rules.flatMap((rule) => {
        const canonical = canonicalizeDurableSkillActionToolRule(rule, {
          semanticCapabilityDefinitions,
          dropGeneratedWithoutMatch: true,
        });
        return canonical ? [canonical] : [];
      }),
    ),
  ];
}

export function semanticCapabilityDefinitionsFromToolCatalog(
  tools: readonly ToolCatalogItem[],
): Record<string, SemanticCapabilityDefinition> | undefined {
  const definitions: Record<string, SemanticCapabilityDefinition> = {};
  for (const tool of tools) {
    if (tool.status !== 'active' || !tool.selectable) continue;
    const capability = semanticCapabilityFromToolCatalogItem({
      name: tool.name,
      inputSchema: tool.inputSchema,
    });
    if (!capability) continue;
    definitions[capability.capabilityId] = capability;
  }
  return Object.keys(definitions).length > 0 ? definitions : undefined;
}

function assertNoRequestCapabilityDefinitionConflicts(input: {
  catalogDefinitions?: Record<string, SemanticCapabilityDefinition>;
  requestDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): void {
  for (const [capabilityId, requestDefinition] of Object.entries(
    input.requestDefinitions ?? {},
  )) {
    const catalogDefinition = input.catalogDefinitions?.[capabilityId];
    if (!catalogDefinition) continue;
    if (
      stableSha256Json(catalogDefinition) ===
      stableSha256Json(requestDefinition)
    ) {
      continue;
    }
    throw new Error(
      `Semantic capability ${capabilityId} does not match the active catalog definition.`,
    );
  }
}

function mergeSemanticCapabilityDefinitions(
  requestDefinitions?: Record<string, SemanticCapabilityDefinition>,
  catalogDefinitions?: Record<string, SemanticCapabilityDefinition>,
): Record<string, SemanticCapabilityDefinition> | undefined {
  const merged = {
    ...(requestDefinitions ?? {}),
    ...(catalogDefinitions ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function persistentPermissionRuleAuditPreviewForRules(
  rules: readonly string[],
): string {
  if (rules.length === 0) return 'unknown';
  if (rules.length === 1 && rules[0]) {
    return durableAccessRuleAuditPreview(rules[0]);
  }
  return rules.map(durableAccessRuleAuditPreview).join(', ');
}

function persistentPermissionGrantAuditMetadata(input: {
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Record<string, unknown> {
  const skillActions = input.rules
    .map((rule) => {
      const capabilityId = parseSemanticCapabilityRule(rule);
      if (!capabilityId) return undefined;
      const capability = input.semanticCapabilityDefinitions?.[capabilityId];
      if (!capability) return undefined;
      const source = skillActionSource(capability);
      if (!source) return undefined;
      return {
        capabilityId,
        displayName: capability.displayName,
        skillId: source.skillId,
        skillName: source.skillName,
        actionId: source.actionId,
        commandPreviewHashes: semanticCapabilityRuntimeRules(capability).map(
          (runtimeRule) => `sha256:${stableSha256Json({ runtimeRule })}`,
        ),
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
  return skillActions.length > 0
    ? { capabilitySource: 'skill_action', skillActions }
    : {};
}

function adminMcpToolFullNameFromRule(allowedRule: string): string | null {
  const trimmed = allowedRule.trim();
  const scoped = parseReadableScopedToolRule(trimmed);
  const toolName = scoped ? scoped.toolName : trimmed;
  return isAdminMcpToolFullName(toolName) ? toolName : null;
}

function persistentPermissionBindingId(
  appId: string,
  agentId: string,
  toolId: string,
): AgentToolBinding['id'] {
  const digest = stableSha256Json({ agentId, appId, toolId }).slice(0, 32);
  return `agent-tool-binding:permission:${digest}` as AgentToolBinding['id'];
}

function resolveRevocationTarget(input: {
  appId: AppId;
  bindings: readonly AgentToolBinding[];
  toolById: ReadonlyMap<ToolId, ToolCatalogItem>;
  toolName?: string;
  toolId?: string;
}): {
  binding: AgentToolBinding;
  rule: string;
  tool: ToolCatalogItem | undefined;
} {
  const requestedToolId = input.toolId?.trim();
  const requestedToolName = input.toolName?.trim();
  if (!requestedToolId && !requestedToolName) {
    throw new Error('admin_permission_revoke requires tool_id or tool_name.');
  }
  let binding: AgentToolBinding | undefined;
  if (requestedToolId) {
    binding = input.bindings.find(
      (candidate) => candidate.toolId === requestedToolId,
    );
  }
  if (!binding && requestedToolName) {
    const candidateIds = candidateToolIdsForRule(
      input.appId,
      requestedToolName,
    );
    binding = input.bindings.find((candidate) => {
      if (candidateIds.has(candidate.toolId)) return true;
      const tool = input.toolById.get(candidate.toolId);
      return (
        tool?.name?.trim() === requestedToolName ||
        displayToolReference({ toolId: candidate.toolId, tool }) ===
          requestedToolName
      );
    });
  }
  if (!binding) {
    throw new Error(
      `No active current-agent tool grant matches ${requestedToolId ?? requestedToolName}.`,
    );
  }
  const tool = input.toolById.get(binding.toolId);
  const rule = displayToolReference({ toolId: binding.toolId, tool });
  const validation = validateReadableAgentToolRule(rule);
  if (!validation.ok) {
    throw new Error(
      `Cannot revoke unreadable tool grant ${binding.toolId}: ${validation.reason}`,
    );
  }
  return { binding, rule, tool };
}

function expandedRevocationLiveRules(input: {
  rule: string;
  tool?: ToolCatalogItem;
}): string[] {
  const capability = input.tool
    ? semanticCapabilityFromToolCatalogItem({
        name: input.tool.name ?? input.rule,
        inputSchema: input.tool.inputSchema,
      })
    : undefined;
  return expandSemanticCapabilityPermissionRules({
    rules: [input.rule],
    definitions: capability
      ? { [capability.capabilityId]: capability }
      : undefined,
  });
}

function candidateToolIdsForRule(appId: AppId, rule: string): Set<ToolId> {
  const out = new Set<ToolId>();
  if (isCanonicalBrowserCapabilityRule(rule)) out.add('tool:Browser' as ToolId);
  if (isAdminMcpToolFullName(rule)) {
    out.add(adminMcpToolIdForFullName(rule) as ToolId);
  }
  const semanticCapabilityId = parseSemanticCapabilityRule(rule);
  if (semanticCapabilityId) {
    out.add(`tool:capability:${semanticCapabilityId}` as ToolId);
  }
  out.add(persistentPermissionToolId(appId, rule) as ToolId);
  return out;
}
