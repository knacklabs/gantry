import type { ControlPlaneNextAction } from '../control-plane/control-plane-read-model.js';
/**
 * Canonical, executable guided actions. Every actionable `nextAction` surfaced
 * anywhere in Gantry (control plane summary, doctor checks, blocked jobs, ...)
 * resolves to exactly one of these types. This is the structured action model
 * the Guided Action Service will execute; today it is the shared vocabulary
 * that replaces scattered free-text remediation strings.
 */
export type GuidedActionType = 'connect_provider' | 'add_conversation_install' | 'grant_access' | 'resume_job' | 'review_memory' | 'change_agent_model' | 'restart_runtime' | 'run_verification' | 'none';
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
export declare const GUIDED_ACTION_DESCRIPTORS: Record<GuidedActionType, GuidedActionDescriptor>;
export declare function describeGuidedAction(type: GuidedActionType): GuidedActionDescriptor;
/**
 * Total mapping from a control-plane next-action kind to a guided action type.
 * The exhaustive switch (no `default`) is intentional: adding a new
 * `ControlPlaneNextAction` kind is a compile error until it is mapped here,
 * which is how we guarantee "every Next action has exactly one guided action".
 */
export declare function guidedActionTypeForControlPlaneKind(kind: ControlPlaneNextAction['kind']): GuidedActionType;
/**
 * Resolve a control-plane next-action into an executable guided action,
 * preserving the source's plain-English label and any target params (e.g. the
 * concrete jobId for a resume_job action).
 */
export declare function resolveControlPlaneGuidedAction(nextAction: ControlPlaneNextAction): GuidedActionRef;
