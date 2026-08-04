export declare const SEMANTIC_CAPABILITY_RULE_PREFIX = "capability:";
export declare function semanticCapabilityRule(capabilityId: string): string;
export declare function parseSemanticCapabilityRule(value: string): string | undefined;
export declare function isSemanticCapabilityRule(value: string): boolean;
export declare function isValidSemanticCapabilityId(value: string): boolean;
export declare function semanticCapabilityIdValidationReason(capabilityId: string): string | undefined;
