import { describeGuidedAction, } from './guided-action-model.js';
/**
 * The single application-level entry point that turns a structured
 * {@link GuidedActionRef} into a preview and an execution with a standardized
 * receipt. Each surface (CLI / Control API / MCP) constructs this with the
 * executors it can support and shares the same preview/receipt formatting, so
 * the receipt shape is identical everywhere.
 */
export class GuidedActionService {
    executors;
    constructor(executors = {}) {
        this.executors = executors;
    }
    /** Pure, side-effect-free preview built from the action's authority descriptor. */
    preview(ref) {
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
    async execute(ref) {
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
        }
        catch (err) {
            return {
                status: 'failed',
                cause: err instanceof Error ? err.message : String(err),
                recover: ref.label,
            };
        }
    }
}
const YES_NO = (value) => (value ? 'Yes' : 'No');
export function formatGuidedActionPreview(preview) {
    return [
        `Action: ${preview.label}`,
        `Effect: ${preview.effect}`,
        `Requires approval: ${YES_NO(preview.requiresApproval)}`,
        `Writes settings.yaml: ${YES_NO(preview.writesSettings)}`,
        `Restarts runtime: ${YES_NO(preview.restartsRuntime)}`,
    ].join('\n');
}
function guidedActionFailureReceipt(result) {
    return {
        summary: 'Could not complete action.',
        cause: result.cause,
        recover: result.recover,
    };
}
/** Render any execution result using the standardized receipt copy. */
export function formatGuidedActionResult(result) {
    if (result.status === 'done') {
        return [
            `Done. ${result.changed}`,
            `I saved it to ${result.savedTo}.`,
            result.restartRequired
                ? 'A runtime restart is required.'
                : 'No runtime restart is needed.',
            result.nextAction,
        ].join('\n');
    }
    if (result.status === 'manual') {
        return ['Manual step required.', '', `Command: ${result.instruction}`].join('\n');
    }
    const receipt = guidedActionFailureReceipt(result);
    return [
        receipt.summary,
        '',
        `cause: ${receipt.cause}`,
        `recover: ${receipt.recover}`,
    ].join('\n');
}
