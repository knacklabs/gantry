import { type FlowAction } from './setup-flow-control.js';
import type { SetupDraft } from './setup-flow-state.js';
export declare function runAddAgentSetupSlice(runtimeHome: string): Promise<number>;
export declare function runWelcomeStep(): Promise<FlowAction>;
export declare function runRuntimeHomeStep(draft: SetupDraft): Promise<{
    action: FlowAction;
    changedHome?: string;
}>;
export declare function runStorageStep(draft: SetupDraft): Promise<FlowAction>;
export declare function runChannelStep(draft: SetupDraft): Promise<FlowAction>;
export declare function runModelStep(draft: SetupDraft): Promise<FlowAction>;
export declare function chatModelSelectOptions(): Array<{
    value: string;
    label: string;
    hint: string;
}>;
export declare function runMemoryStep(draft: SetupDraft): Promise<FlowAction>;
