import type { ControlPlaneNextAction } from '../control-plane/control-plane-read-model.js';

/**
 * Canonical, executable guided actions. Every actionable `nextAction` surfaced
 * anywhere in Gantry (control plane summary, doctor checks, blocked jobs, ...)
 * resolves to exactly one of these types. This is the structured action model
 * the Guided Action Service will execute; today it is the shared vocabulary
 * that replaces scattered free-text remediation strings.
 */
export type GuidedActionType =
  | 'connect_provider'
  | 'add_conversation_binding'
  | 'grant_access'
  | 'resume_job'
  | 'review_memory'
  | 'change_agent_model'
  | 'restart_runtime'
  | 'run_verification'
  | 'none';

/**
 * A concrete, executable reference to a guided action. `params` carries target
 * identifiers (providerId, jobId, agentId, ...) when the source knows them, so
 * the executor can act without re-deriving the target.
 */
export interface GuidedActionRef {
  type: GuidedActionType;
  /** Plain-English action shown to the operator. */
  label: string;
  params?: Record<string, string>;
}

/**
 * Static authority/impact declaration for an action type. Satisfies the Guided
 * Operations contract requirement that every action declares what it changes
 * before it runs.
 *
 * Authority fields are declared CONSERVATIVELY: they describe the strongest
 * impact the action type can have, so the contract never under-reports a
 * settings write or a restart. Per-instance refinement (an action that happens
 * not to write settings) is the executor's job, not this static table's.
 */
export interface GuidedActionDescriptor {
  type: GuidedActionType;
  /** One-line description of what the action changes. */
  effect: string;
  requiresApproval: boolean;
  /** Writes desired state to settings.yaml. */
  writesSettings: boolean;
  restartsRuntime: boolean;
}

export const GUIDED_ACTION_DESCRIPTORS: Record<
  GuidedActionType,
  GuidedActionDescriptor
> = {
  connect_provider: {
    type: 'connect_provider',
    effect: 'Connects a provider and enables it for routing.',
    requiresApproval: false,
    writesSettings: true,
    restartsRuntime: false,
  },
  add_conversation_binding: {
    type: 'add_conversation_binding',
    effect: 'Binds an agent to a conversation.',
    requiresApproval: false,
    writesSettings: true,
    restartsRuntime: false,
  },
  grant_access: {
    type: 'grant_access',
    // Grants are durable in the access policy (Postgres), but the current grant
    // path (applyPersistentToolRuleGrant) also mirrors the rule into
    // settings.yaml. Declared as a settings writer so the preview never hides
    // that write.
    effect:
      'Approves a pending access request in the durable access policy (also mirrored to settings.yaml).',
    requiresApproval: true,
    writesSettings: true,
    restartsRuntime: false,
  },
  resume_job: {
    type: 'resume_job',
    // Resuming re-checks a paused/blocked job's setup and re-runs it if ready.
    // Writes job/runtime state only, never desired state.
    effect: 'Resumes a paused or blocked job and re-checks its setup.',
    requiresApproval: false,
    writesSettings: false,
    restartsRuntime: false,
  },
  review_memory: {
    type: 'review_memory',
    // Reviewing items writes the memory store; completing setup writes
    // settings.yaml. Declared conservatively as a settings writer.
    effect: 'Reviews pending memory items or completes memory setup.',
    requiresApproval: false,
    writesSettings: true,
    restartsRuntime: false,
  },
  change_agent_model: {
    type: 'change_agent_model',
    effect: "Changes an agent's model.",
    requiresApproval: false,
    writesSettings: true,
    restartsRuntime: false,
  },
  restart_runtime: {
    type: 'restart_runtime',
    // Restart is explicit, never hidden, and always operator-approved.
    effect: 'Restarts the Gantry runtime.',
    requiresApproval: true,
    writesSettings: false,
    restartsRuntime: true,
  },
  run_verification: {
    type: 'run_verification',
    effect: 'Runs runtime diagnostics and verification checks.',
    requiresApproval: false,
    writesSettings: false,
    restartsRuntime: false,
  },
  none: {
    type: 'none',
    effect: 'No action required.',
    requiresApproval: false,
    writesSettings: false,
    restartsRuntime: false,
  },
};

export function describeGuidedAction(
  type: GuidedActionType,
): GuidedActionDescriptor {
  return GUIDED_ACTION_DESCRIPTORS[type];
}

/**
 * Total mapping from a control-plane next-action kind to a guided action type.
 * The exhaustive switch (no `default`) is intentional: adding a new
 * `ControlPlaneNextAction` kind is a compile error until it is mapped here,
 * which is how we guarantee "every Next action has exactly one guided action".
 */
export function guidedActionTypeForControlPlaneKind(
  kind: ControlPlaneNextAction['kind'],
): GuidedActionType {
  switch (kind) {
    case 'runtime_blocked':
      return 'run_verification';
    case 'missing_model_credential':
      return 'connect_provider';
    case 'missing_provider_connection':
      return 'connect_provider';
    case 'missing_conversation_binding':
      return 'add_conversation_binding';
    case 'missing_access_approval':
      return 'grant_access';
    case 'blocked_job':
      return 'resume_job';
    case 'memory_review_setup':
      return 'review_memory';
    case 'none':
      return 'none';
  }
}

/**
 * Resolve a control-plane next-action into an executable guided action,
 * preserving the source's plain-English label and any target params (e.g. the
 * concrete jobId for a resume_job action).
 */
export function resolveControlPlaneGuidedAction(
  nextAction: ControlPlaneNextAction,
): GuidedActionRef {
  return {
    type: guidedActionTypeForControlPlaneKind(nextAction.kind),
    label: nextAction.label,
    ...(nextAction.params ? { params: nextAction.params } : {}),
  };
}
