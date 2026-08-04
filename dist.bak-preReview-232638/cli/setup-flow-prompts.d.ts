import { type FlowAction } from './setup-flow-control.js';
export declare function chooseProgressAction(options: {
    message: string;
    continueLabel?: string;
    includeBack?: boolean;
}): Promise<FlowAction>;
