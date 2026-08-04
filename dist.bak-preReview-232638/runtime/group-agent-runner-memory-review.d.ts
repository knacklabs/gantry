import type { GroupProcessingDeps } from './group-processing-types.js';
export declare function memoryReviewerApproverAllowed(deps: GroupProcessingDeps, conversationJid: string, sourceAgentFolder: string, userId?: string): Promise<boolean>;
