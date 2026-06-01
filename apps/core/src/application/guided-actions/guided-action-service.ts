import type { OperatorErrorReceipt } from '../../shared/operator-error.js';
import {
  describeGuidedAction,
  type GuidedActionRef,
  type GuidedActionType,
} from './guided-action-model.js';

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

export type GuidedActionSavedTo =
  | 'settings.yaml'
  | 'runtime state'
  | 'access policy'
  | 'none';

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

export type GuidedActionResult =
  | GuidedActionDone
  | GuidedActionFailed
  | GuidedActionManual;

export type GuidedActionExecutor = (
  ref: GuidedActionRef,
) => Promise<GuidedActionResult> | GuidedActionResult;

export type GuidedActionExecutorMap = Partial<
  Record<GuidedActionType, GuidedActionExecutor>
>;

/**
 * The single application-level entry point that turns a structured
 * {@link GuidedActionRef} into a preview and an execution with a standardized
 * receipt. Each surface (CLI / Control API / MCP) constructs this with the
 * executors it can support and shares the same preview/receipt formatting, so
 * the receipt shape is identical everywhere.
 */
export class GuidedActionService {
  constructor(private readonly executors: GuidedActionExecutorMap = {}) {}

  /** Pure, side-effect-free preview built from the action's authority descriptor. */
  preview(ref: GuidedActionRef): GuidedActionPreview {
    const descriptor = describeGuidedAction(ref.type);
    return {
      action: ref.type,
      label: ref.label,
      effect: descriptor.effect,
      requiresApproval: descriptor.requiresApproval,
      writesSettings: descriptor.writesSettings,
      restartsRuntime: descriptor.restartsRuntime,
    };
  }

  async execute(ref: GuidedActionRef): Promise<GuidedActionResult> {
    if (ref.type === 'none') {
      return {
        status: 'done',
        changed: 'Nothing to do.',
        savedTo: 'none',
        restartRequired: false,
        nextAction: 'none',
      };
    }
    const executor = this.executors[ref.type];
    if (!executor) {
      return { status: 'manual', instruction: ref.label };
    }
    try {
      return await executor(ref);
    } catch (err) {
      return {
        status: 'failed',
        cause: err instanceof Error ? err.message : String(err),
        recover: ref.label,
      };
    }
  }
}

const YES_NO = (value: boolean): string => (value ? 'Yes' : 'No');

export function formatGuidedActionPreview(
  preview: GuidedActionPreview,
): string {
  return [
    `Action: ${preview.label}`,
    `Effect: ${preview.effect}`,
    `Requires approval: ${YES_NO(preview.requiresApproval)}`,
    `Writes settings.yaml: ${YES_NO(preview.writesSettings)}`,
    `Restarts runtime: ${YES_NO(preview.restartsRuntime)}`,
  ].join('\n');
}

function guidedActionFailureReceipt(
  result: GuidedActionFailed,
): OperatorErrorReceipt {
  return {
    summary: 'Could not complete action.',
    cause: result.cause,
    recover: result.recover,
  };
}

/** Render any execution result using the standardized receipt copy. */
export function formatGuidedActionResult(result: GuidedActionResult): string {
  if (result.status === 'done') {
    return [
      'Done.',
      '',
      `Changed: ${result.changed}`,
      `Saved to: ${result.savedTo}`,
      `Restart required: ${YES_NO(result.restartRequired)}`,
      `Next action: ${result.nextAction}`,
    ].join('\n');
  }
  if (result.status === 'manual') {
    return ['Manual step required.', '', `Command: ${result.instruction}`].join(
      '\n',
    );
  }
  const receipt = guidedActionFailureReceipt(result);
  return [
    receipt.summary,
    '',
    `cause: ${receipt.cause}`,
    `recover: ${receipt.recover}`,
  ].join('\n');
}
