import type { AgentRunnerInput } from './types.js';
import type { JobSetupAction } from '../../../../domain/job-types.js';
import { jobSetupActionEventPayload } from '../../../../domain/events/job-setup-action.js';
import { writeOutput } from './output.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { permissionRequestToolName } from './permission-suggestions.js';
import type { YoloModeMatch } from '../../../../shared/yolo-mode-policy.js';
import type { PermissionDecision } from './types.js';
import type { AgentRunnerRuntimeEventOutput } from './types.js';
import { permissionUpdateAllowedToolRules } from '../../../../shared/permission-tool-rules.js';
import { formatPermissionDeniedMessage } from '../../../../shared/permission-decision-message.js';
import { DEFAULT_AGENT_ENGINE } from '../../../../shared/agent-engine.js';
import { terminalToolActivityPayload } from '../../../../domain/events/tool-activity.js';
import type { ToolActivityFamily } from '../../../../domain/events/tool-activity.js';
import { canonicalGantryToolRuleName } from '../../../../shared/gantry-tool-facades.js';
import type { DurableAccessReformulationResult } from '../../../../shared/durable-access-policy.js';

export function yoloDenylistPromptReason(match: YoloModeMatch): string {
  return `A YOLO-mode denylist rule matched "${match.pattern}", so this tool needs explicit approval.`;
}

export function emitYoloDenylistHit(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  match: YoloModeMatch;
  principal: string;
  reason: string;
}): void {
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: input.getNewSessionId(),
    runtimeEvents: [
      {
        appId: input.agentInput.appId,
        agentId: input.agentInput.agentId,
        runId: input.agentInput.runId,
        jobId: input.agentInput.jobId,
        conversationId: input.agentInput.chatJid,
        threadId: input.agentInput.threadId,
        eventType: RUNTIME_EVENT_TYPES.PERMISSION_YOLO_DENYLIST_HIT,
        actor: 'runner',
        responseMode: 'none',
        payload: {
          decision: 'yolo_denylist_hit',
          matchedPattern: input.match.pattern,
          matchKind: input.match.kind,
          tool: input.match.toolName,
          principal: input.principal,
          reason: input.reason,
          conversationId: input.agentInput.chatJid,
        },
      },
    ],
  });
}

export function emitToolActivity(
  agentInput: AgentRunnerInput,
  getNewSessionId: () => string | undefined,
  phase: string,
  toolName: string,
  payload: Record<string, unknown> = {},
): void {
  if (agentInput.parentTaskId) return;
  const publicToolName = permissionRequestToolName(toolName);
  const invocationId =
    typeof payload.invocationId === 'string' && payload.invocationId.trim()
      ? payload.invocationId.trim()
      : undefined;
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: getNewSessionId(),
    runtimeEventOnly: true,
    runtimeEvents: [
      {
        appId: agentInput.appId,
        agentId: agentInput.agentId,
        runId: agentInput.runId,
        jobId: agentInput.jobId,
        conversationId: agentInput.chatJid,
        threadId: agentInput.threadId,
        eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
        actor: 'runner',
        ...(invocationId ? { correlationId: invocationId } : {}),
        responseMode: 'none',
        payload: {
          phase,
          tool: publicToolName,
          sdk_tool: toolName,
          ...payload,
        },
      },
    ],
  });
}

export function emitPermissionReformulationDenial(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  toolName: string;
  invocationId?: string;
  result: DurableAccessReformulationResult;
}): {
  behavior: 'deny';
  message: string;
  interrupt: false;
} {
  emitToolActivity(
    input.agentInput,
    input.getNewSessionId,
    'deny',
    input.toolName,
    {
      ok: false,
      reason: input.result.message,
      decision: input.result.code,
      result_kind: input.result.kind,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    },
  );
  return {
    behavior: 'deny',
    message: input.result.message,
    interrupt: false,
  };
}

export function emitTerminalToolActivity(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  invocationId: string;
  toolName: string;
  family?: ToolActivityFamily;
  outcome: 'success' | 'failure';
  seq: number;
  detail?: string;
}): void {
  const event = terminalToolActivityRuntimeEvent(input);
  if (!event) return;
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: input.getNewSessionId(),
    runtimeEventOnly: true,
    runtimeEvents: [event],
  });
}

export function terminalToolActivityRuntimeEvent(input: {
  agentInput: AgentRunnerInput;
  invocationId: string;
  toolName: string;
  family?: ToolActivityFamily;
  outcome: 'success' | 'failure';
  seq: number;
  detail?: string;
}): AgentRunnerRuntimeEventOutput | null {
  if (input.agentInput.parentTaskId) return null;
  const tool = canonicalGantryToolRuleName(
    permissionRequestToolName(input.toolName),
  );
  return {
    appId: input.agentInput.appId,
    agentId: input.agentInput.agentId,
    runId: input.agentInput.runId,
    jobId: input.agentInput.jobId,
    conversationId: input.agentInput.chatJid,
    threadId: input.agentInput.threadId,
    eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
    actor: 'runner',
    correlationId: input.invocationId,
    responseMode: 'none',
    payload: terminalToolActivityPayload({
      invocationId: input.invocationId,
      tool,
      family: input.family,
      outcome: input.outcome,
      seq: input.seq,
      detail: input.detail,
    }),
  };
}

// S2a (decision 0126): one authoring site for the gate lane's terminal-denial
// activity so the five gate guards stay uniform and the provider-boundary
// token count stays stable (A-0060: lane = DEFAULT_AGENT_ENGINE).
export function emitGateDenialActivity(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  toolName: string;
  invocationId?: string;
  reason: string;
  decision?: string;
  denialKind?: 'rule_denied' | 'permission_denied';
  action: JobSetupAction;
}): void {
  const scheduled = input.agentInput.isScheduledJob;
  emitToolActivity(
    input.agentInput,
    input.getNewSessionId,
    scheduled ? 'permission_denied' : 'deny',
    input.toolName,
    {
      ok: false,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      reason: input.reason,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(scheduled
        ? {
            terminal: true,
            action: jobSetupActionEventPayload(input.action),
            denial_kind: input.denialKind ?? 'rule_denied',
            provenance_lane: DEFAULT_AGENT_ENGINE,
            provenance_seam: 'gate',
          }
        : {}),
    },
  );
}

// Typed source, never free-form decidedBy (human 'birthright' still surfaces).
const SILENT_SOURCES = new Set(['birthright', 'deterministic_policy']);
export function permissionAllowedActivityPayload(
  decision: PermissionDecision,
): Record<string, unknown> {
  const provenanceMessage = formatPermissionAllowedMessage(decision);
  // Allow-once on a scheduled run: carry the READABLE approved rule so the
  // transient pause can build a typed one-tap grant with the true scope -
  // never by re-parsing recovery protocol text (0125).
  const allowedRules = permissionUpdateAllowedToolRules(
    (decision as { updatedPermissions?: unknown[] }).updatedPermissions,
  );
  return {
    ok: true,
    mode: decision.mode,
    ...(allowedRules[0] ? { allowed_rule: allowedRules[0] } : {}),
    ...(decision.decidedBy ? { decided_by: decision.decidedBy } : {}),
    ...(decision.source ? { source: decision.source } : {}),
    ...(typeof decision.repeatableForFutureRuns === 'boolean'
      ? { repeatableForFutureRuns: decision.repeatableForFutureRuns }
      : {}),
    ...(decision.risk_level ? { risk_level: decision.risk_level } : {}),
    ...(decision.risk_category
      ? { risk_category: decision.risk_category }
      : {}),
    ...(provenanceMessage
      ? { reason: provenanceMessage }
      : decision.reason
        ? { reason: decision.reason }
        : {}),
  };
}
export function formatPermissionAllowedMessage(
  decision: PermissionDecision,
): string | undefined {
  if (decision.source && SILENT_SOURCES.has(decision.source)) {
    return undefined;
  }
  if (!decision.decidedBy && !decision.risk_level) return undefined;
  return formatPermissionDeniedMessage(decision, '')
    .replace(/^Permission denied/, 'Permission allowed')
    .replace(/: $/, '');
}
