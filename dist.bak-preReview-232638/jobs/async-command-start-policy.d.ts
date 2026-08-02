import { ToolExecutionClassifier, ToolExecutionPolicyService } from '../shared/tool-execution-policy-service.js';
export declare function evaluateAsyncCommandStartPolicy(input: {
    command: string;
    conversationId: string;
    threadId?: string | null;
    parentJobId?: string | null;
    allowedToolRules: readonly string[];
    memoryBlock?: string;
    isScheduledJob?: boolean;
    classifier: ToolExecutionClassifier;
    policy: ToolExecutionPolicyService;
}): {
    ok: true;
    matchedRule?: string;
} | {
    ok: false;
    message: string;
};
