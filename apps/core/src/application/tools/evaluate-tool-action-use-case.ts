import type { AppId } from '../../domain/app/app.js';
import type {
  PermissionDecision,
  PermissionDecisionId,
  PermissionEffect,
  PermissionPolicyId,
  PermissionRuleId,
} from '../../domain/permissions/permissions.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { ToolId } from '../../domain/tools/tools.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import {
  anyToolRuleMatches,
  normalizeToolRules,
} from '../../shared/tool-rule-matcher.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';

export interface ToolActionTransientApproval {
  toolName: string;
  approverRef?: string;
  expiresAt?: IsoTimestamp;
}

export interface EvaluateToolActionInput {
  appId: AppId;
  toolName: string;
  actionPreview?: string;
  actorContext?: Record<string, unknown>;
  runId?: AgentRunId;
  toolId?: ToolId;
  policyId?: PermissionPolicyId;
  ruleIds?: PermissionRuleId[];
  allowedToolRules?: readonly unknown[];
  deniedToolRules?: readonly unknown[];
  approvalToolRules?: readonly unknown[];
  sandboxRequiredToolRules?: readonly unknown[];
  transientApprovals?: readonly ToolActionTransientApproval[];
}

export interface IdGenerator {
  generate(): string;
}

export class EvaluateToolActionUseCase {
  constructor(
    private readonly deps: {
      ids?: IdGenerator;
      clock?: Clock;
    } = {},
  ) {}

  async execute(input: EvaluateToolActionInput): Promise<{
    decision: PermissionDecision;
  }> {
    const toolName = input.toolName.trim();
    if (!toolName) {
      throw new ApplicationError('INVALID_REQUEST', 'Tool name is required');
    }
    const now = this.now();
    const transientApproval = validTransientApproval(
      input.transientApprovals,
      toolName,
      now,
    );
    if (transientApproval) {
      return {
        decision: this.decision(input, {
          effect: 'allow',
          reason: 'Allowed by transient approval.',
          approverRef: transientApproval.approverRef,
        }),
      };
    }

    if (matches(input.deniedToolRules, toolName)) {
      return {
        decision: this.decision(input, {
          effect: 'deny',
          reason: `Denied by tool policy for ${toolName}.`,
        }),
      };
    }
    if (matches(input.allowedToolRules, toolName)) {
      return {
        decision: this.decision(input, {
          effect: 'allow',
          reason: `Allowed by selected capability rule for ${toolName}.`,
        }),
      };
    }
    if (matches(input.sandboxRequiredToolRules, toolName)) {
      return {
        decision: this.decision(input, {
          effect: 'require_sandbox',
          reason: `Tool ${toolName} requires a sandbox profile.`,
        }),
      };
    }
    if (matches(input.approvalToolRules, toolName)) {
      return {
        decision: this.decision(input, {
          effect: 'require_approval',
          reason: `Tool ${toolName} requires approval.`,
        }),
      };
    }
    return {
      decision: this.decision(input, {
        effect: 'deny',
        reason: `No matching permission rule for ${toolName}.`,
      }),
    };
  }

  private decision(
    input: EvaluateToolActionInput,
    outcome: {
      effect: PermissionEffect;
      reason: string;
      approverRef?: string;
    },
  ): PermissionDecision {
    const toolName = input.toolName.trim();
    return {
      id: `permission-decision:${this.id()}` as PermissionDecisionId,
      appId: input.appId,
      ...(input.policyId ? { policyId: input.policyId } : {}),
      ruleIds: input.ruleIds ?? [],
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.toolId ? { toolId: input.toolId } : {}),
      effect: outcome.effect,
      reason: outcome.reason,
      actorContext: {
        ...(input.actorContext ?? {}),
        toolName,
      },
      ...(input.actionPreview ? { actionPreview: input.actionPreview } : {}),
      ...(outcome.approverRef ? { approverRef: outcome.approverRef } : {}),
      createdAt: this.now(),
    };
  }

  private id(): string {
    return this.deps.ids?.generate() ?? globalThis.crypto.randomUUID();
  }

  private now(): IsoTimestamp {
    return (this.deps.clock?.now() ?? new Date().toISOString()) as IsoTimestamp;
  }
}

function matches(rules: readonly unknown[] | undefined, toolName: string) {
  return anyToolRuleMatches(normalizeToolRules(rules), toolName);
}

function validTransientApproval(
  approvals: readonly ToolActionTransientApproval[] | undefined,
  toolName: string,
  now: IsoTimestamp,
): ToolActionTransientApproval | null {
  if (!Array.isArray(approvals)) return null;
  return (
    approvals.find((approval) => {
      if (approval.toolName.trim() !== toolName) return false;
      if (!approval.expiresAt) return true;
      return Date.parse(approval.expiresAt) > Date.parse(now);
    }) ?? null
  );
}
