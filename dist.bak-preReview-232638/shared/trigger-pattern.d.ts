export declare function escapeRegex(str: string): string;
export declare function defaultTriggerForAgentName(name?: string | null): string;
export declare function triggerForRoute(input: {
    trigger?: string | null;
    name?: string | null;
}): string;
export declare function buildTriggerPattern(trigger: string): RegExp;
