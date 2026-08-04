import { type GuidedActionRef, type GuidedActionType } from './guided-action-model.js';
/**
 * The preview an operator sees BEFORE a guided action runs. Mirrors the Guided
 * Operations UX contract: action / effect / requires approval / writes
 * settings.yaml / restarts runtime.
 */
export interface GuidedActionPreview {
    action: GuidedActionType;
    label: string;
    effect: string;
    requiresApproval: boolean;
    writesSettings: boolean;
    restartsRuntime: boolean;
}
export type GuidedActionSavedTo = 'settings.yaml' | 'runtime state' | 'access policy' | 'none';
/** A guided action that ran and changed something (or confirmed nothing to do). */
export interface GuidedActionDone {
    status: 'done';
    changed: string;
    savedTo: GuidedActionSavedTo;
    restartRequired: boolean;
    /** Follow-up action, or 'none'. */
    nextAction: string;
}
/** A guided action that was attempted and failed, in cause/recover form. */
export interface GuidedActionFailed {
    status: 'failed';
    cause: string;
    recover: string;
}
/**
 * A guided action with no automated executor on this surface. The roadmap
 * permits "explicitly says diagnostics/manual required" instead of executing;
 * `instruction` is the exact next step (the source's plain-English label).
 */
export interface GuidedActionManual {
    status: 'manual';
    instruction: string;
}
export type GuidedActionResult = GuidedActionDone | GuidedActionFailed | GuidedActionManual;
export type GuidedActionExecutor = (ref: GuidedActionRef) => Promise<GuidedActionResult> | GuidedActionResult;
export type GuidedActionExecutorMap = Partial<Record<GuidedActionType, GuidedActionExecutor>>;
/**
 * The single application-level entry point that turns a structured
 * {@link GuidedActionRef} into a preview and an execution with a standardized
 * receipt. Each surface (CLI / Control API / MCP) constructs this with the
 * executors it can support and shares the same preview/receipt formatting, so
 * the receipt shape is identical everywhere.
 */
export declare class GuidedActionService {
    private readonly executors;
    constructor(executors?: GuidedActionExecutorMap);
    /** Pure, side-effect-free preview built from the action's authority descriptor. */
    preview(ref: GuidedActionRef): GuidedActionPreview;
    execute(ref: GuidedActionRef): Promise<GuidedActionResult>;
}
export declare function formatGuidedActionPreview(preview: GuidedActionPreview): string;
/** Render any execution result using the standardized receipt copy. */
export declare function formatGuidedActionResult(result: GuidedActionResult): string;
