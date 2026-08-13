import type { RuntimeEvent } from './events.js';
import { RUNTIME_EVENT_TYPES } from './runtime-event-types.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
  type AgentEngine,
} from '../../shared/agent-engine.js';

export type JobToolDenialKind =
  | 'permission_denied'
  | 'rule_denied'
  | 'capability_template_mismatch';

// A-0060: the lane reuses the AgentEngine vocabulary (the single sanctioned
// home of the SDK-engine literal) so the provider-boundary gate stays
// count-exact; 'host' covers host-side capability_run production.
export type JobToolDenialProvenanceLane = AgentEngine | 'host';

export type JobToolDenialProvenanceSeam =
  | 'gate'
  | 'recovery'
  | 'declarative'
  | 'capability_run';

export interface JobToolDenial {
  toolName: string;
  reason: string;
  denialKind: JobToolDenialKind;
  provenanceLane: JobToolDenialProvenanceLane;
  provenanceSeam: JobToolDenialProvenanceSeam;
  grantable?: boolean;
  recoveryAction?: string;
  recoveryKind?: string;
}

export interface JobToolDeniedEventPayload {
  denied_tool: string;
  reason: string;
  denial_kind: JobToolDenialKind;
  provenance_lane: JobToolDenialProvenanceLane;
  provenance_seam: JobToolDenialProvenanceSeam;
  grantable: boolean | null;
  recovery_action: string | null;
  recovery_kind: string | null;
  error_summary: string | null;
}

const DENIAL_KINDS = new Set<JobToolDenialKind>([
  'permission_denied',
  'rule_denied',
  'capability_template_mismatch',
]);
const PROVENANCE_LANES = new Set<JobToolDenialProvenanceLane>([
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
  'host',
]);
const PROVENANCE_SEAMS = new Set<JobToolDenialProvenanceSeam>([
  'gate',
  'recovery',
  'declarative',
  'capability_run',
]);

export function parseJobToolDeniedEvent(
  event: Pick<RuntimeEvent, 'eventType' | 'payload'>,
): JobToolDenial | null {
  if (
    event.eventType !== RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (
    typeof payload.denied_tool !== 'string' ||
    !payload.denied_tool.trim() ||
    typeof payload.reason !== 'string' ||
    !payload.reason.trim() ||
    !DENIAL_KINDS.has(payload.denial_kind as JobToolDenialKind) ||
    !PROVENANCE_LANES.has(
      payload.provenance_lane as JobToolDenialProvenanceLane,
    ) ||
    !PROVENANCE_SEAMS.has(
      payload.provenance_seam as JobToolDenialProvenanceSeam,
    ) ||
    !isNullableBoolean(payload.grantable) ||
    !isNullableString(payload.recovery_action) ||
    !isNullableString(payload.recovery_kind)
  ) {
    return null;
  }
  return {
    toolName: payload.denied_tool,
    reason: payload.reason,
    denialKind: payload.denial_kind as JobToolDenialKind,
    provenanceLane: payload.provenance_lane as JobToolDenialProvenanceLane,
    provenanceSeam: payload.provenance_seam as JobToolDenialProvenanceSeam,
    ...(typeof payload.grantable === 'boolean'
      ? { grantable: payload.grantable }
      : {}),
    ...(typeof payload.recovery_action === 'string'
      ? { recoveryAction: payload.recovery_action }
      : {}),
    ...(typeof payload.recovery_kind === 'string'
      ? { recoveryKind: payload.recovery_kind }
      : {}),
  };
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
