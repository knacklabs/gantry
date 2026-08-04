import type { OnboardingStep } from './onboarding-state.js';
export type FlowAction = {
    type: 'next';
} | {
    type: 'start_now';
} | {
    type: 'back';
} | {
    type: 'resume';
} | {
    type: 'cancel';
} | {
    type: 'goto';
    step: OnboardingStep;
};
export declare function toAction(value: unknown): FlowAction;
export declare function isInputFlowControl(value: string): boolean;
export declare function parseInputFlowControl(value: unknown): FlowAction | null;
