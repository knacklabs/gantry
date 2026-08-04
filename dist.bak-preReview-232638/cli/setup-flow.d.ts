import '../channels/register-builtins.js';
import type { OnboardingStep } from './onboarding-state.js';
export { restoreDraft, updateStateData, type SetupDraft, } from './setup-flow-state.js';
export interface SetupFlowOptions {
    importMetaUrl: string;
    runtimeHome: string;
    initialStep?: OnboardingStep;
    title?: string;
}
export interface SetupFlowResult {
    status: 'completed' | 'resumed' | 'cancelled';
    runtimeHome: string;
    startAfterSetup: boolean;
}
export declare function runSetupFlow(options: SetupFlowOptions): Promise<SetupFlowResult>;
