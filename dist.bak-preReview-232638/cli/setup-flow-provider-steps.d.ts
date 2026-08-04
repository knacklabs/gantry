import { type FlowAction } from './setup-flow-control.js';
import type { SetupDraft } from './setup-flow-state.js';
export declare function runTelegramStep(draft: SetupDraft): Promise<FlowAction>;
export declare function runSlackStep(draft: SetupDraft): Promise<FlowAction>;
