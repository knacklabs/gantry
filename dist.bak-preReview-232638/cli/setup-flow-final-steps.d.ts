import { type FlowAction } from './setup-flow-control.js';
import type { SetupDraft } from './setup-flow-state.js';
export declare function runConfigStep(draft: SetupDraft): Promise<FlowAction>;
export declare function runGroupStep(draft: SetupDraft): Promise<FlowAction>;
export declare function runVerifyStep(importMetaUrl: string, draft: SetupDraft): Promise<FlowAction>;
