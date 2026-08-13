import type { RuntimeEvent } from './events.js';
import { RUNTIME_EVENT_TYPES } from './runtime-event-types.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
  type AgentEngine,
} from '../../shared/agent-engine.js';
import type { JobSetupAction } from '../job-types.js';
import { permissionAuthorityAddition } from '../permission-decision.js';
import type { JobSetupActionEventPayload } from './job-setup-action.js';

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
  action: JobSetupAction;
}

export interface JobToolDeniedEventPayload {
  denied_tool: string;
  reason: string;
  denial_kind: JobToolDenialKind;
  provenance_lane: JobToolDenialProvenanceLane;
  provenance_seam: JobToolDenialProvenanceSeam;
  action: JobSetupActionEventPayload;
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
  // Hard cutover (0113): legacy fields (grantable/recovery_action/
  // recovery_kind) or any unexpected key make parsing FAIL - a dual-writing
  // producer must be detected, never silently tolerated.
  const allowedPayloadKeys = new Set([
    'denied_tool',
    'reason',
    'denial_kind',
    'provenance_lane',
    'provenance_seam',
    'action',
    'error_summary',
  ]);
  if (!Object.keys(payload).every((key) => allowedPayloadKeys.has(key))) {
    return null;
  }
  const action = parseJobSetupActionValue(payload.action);
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
    !action
  ) {
    return null;
  }
  return {
    toolName: payload.denied_tool,
    reason: payload.reason,
    denialKind: payload.denial_kind as JobToolDenialKind,
    provenanceLane: payload.provenance_lane as JobToolDenialProvenanceLane,
    provenanceSeam: payload.provenance_seam as JobToolDenialProvenanceSeam,
    action,
  };
}

export function parseJobSetupActionValue(
  value: unknown,
): JobSetupAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (
    action.kind === 'instruction' &&
    exactKeys(action, ['kind', 'text']) &&
    typeof action.text === 'string' &&
    action.text.trim()
  ) {
    return { kind: 'instruction', text: action.text };
  }
  if (
    action.kind === 'fix_proposal' &&
    exactKeys(action, ['kind', 'proposal_id']) &&
    typeof action.proposal_id === 'string' &&
    action.proposal_id.trim()
  ) {
    return { kind: 'fix_proposal', proposalId: action.proposal_id };
  }
  if (
    action.kind !== 'approve_grant' ||
    !exactKeys(action, ['kind', 'grant'])
  ) {
    return null;
  }
  // The wire grant is STRICTLY snake_case (tool_name/rule_content) - the
  // producers cut over in the same stage, so a camelCase fallback would be a
  // forbidden dual format (0113). Malformed shapes return null, never throw.
  const wireGrant = action.grant;
  if (!wireGrant || typeof wireGrant !== 'object' || Array.isArray(wireGrant)) {
    return null;
  }
  const grantRecord = wireGrant as Record<string, unknown>;
  const allowedGrantKeys = new Set([
    'type',
    'behavior',
    'rules',
    'destination',
  ]);
  if (!Object.keys(grantRecord).every((key) => allowedGrantKeys.has(key))) {
    return null;
  }
  if (!Array.isArray(grantRecord.rules)) return null;
  const decodedRules: Array<{ toolName: string; ruleContent?: string }> = [];
  for (const rule of grantRecord.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const record = rule as Record<string, unknown>;
    const allowed = new Set(['tool_name', 'rule_content']);
    if (!Object.keys(record).every((key) => allowed.has(key))) return null;
    if (typeof record.tool_name !== 'string' || !record.tool_name.trim()) {
      return null;
    }
    if (
      record.rule_content !== undefined &&
      typeof record.rule_content !== 'string'
    ) {
      return null;
    }
    decodedRules.push({
      toolName: record.tool_name,
      ...(record.rule_content !== undefined
        ? { ruleContent: record.rule_content }
        : {}),
    });
  }
  const grant = permissionAuthorityAddition({
    type: grantRecord.type,
    behavior: grantRecord.behavior,
    rules: decodedRules,
    ...(grantRecord.destination
      ? { destination: grantRecord.destination }
      : {}),
  } as Parameters<typeof permissionAuthorityAddition>[0]);
  return grant ? { kind: 'approve_grant', grant } : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}
