import type { AgentRunnerInput } from './types.js';
import type { JobSetupAction } from '../../../../domain/job-types.js';
import { jobSetupActionEventPayload } from '../../../../domain/events/job-setup-action.js';
import { writeOutput } from './output.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { permissionRequestToolName } from './permission-suggestions.js';
import type { YoloModeMatch } from '../../../../shared/yolo-mode-policy.js';
import { DEFAULT_AGENT_ENGINE } from '../../../../shared/agent-engine.js';

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

export function emitJobToolActivity(
  agentInput: AgentRunnerInput,
  getNewSessionId: () => string | undefined,
  phase: string,
  toolName: string,
  payload: Record<string, unknown> = {},
): void {
  if (!agentInput.isScheduledJob || !agentInput.jobId) return;
  const publicToolName = permissionRequestToolName(toolName);
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: getNewSessionId(),
    runtimeEvents: [
      {
        appId: agentInput.appId,
        agentId: agentInput.agentId,
        runId: agentInput.runId,
        jobId: agentInput.jobId,
        conversationId: agentInput.chatJid,
        threadId: agentInput.threadId,
        eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        actor: 'runner',
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

// S2a (decision 0126): one authoring site for the gate lane's terminal-denial
// activity so the five gate guards stay uniform and the provider-boundary
// token count stays stable (A-0060: lane = DEFAULT_AGENT_ENGINE).
export function emitGateDenialActivity(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  toolName: string;
  reason: string;
  decision?: string;
  denialKind?: 'rule_denied' | 'permission_denied';
  action: JobSetupAction;
}): void {
  const scheduled = input.agentInput.isScheduledJob;
  emitJobToolActivity(
    input.agentInput,
    input.getNewSessionId,
    scheduled ? 'permission_denied' : 'deny',
    input.toolName,
    {
      ok: false,
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
