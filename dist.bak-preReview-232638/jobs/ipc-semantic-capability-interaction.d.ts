export interface SemanticCapabilityReview {
    toolName: string;
    toolInput: Record<string, unknown>;
}
export declare function semanticCapabilityInteraction(review: SemanticCapabilityReview, requestId: string): {
    id: string;
    title: string;
    details: {
        label: string;
        value: string;
    }[];
    requestContext: {
        requestId: string;
        capabilityId: string;
        capabilityDisplayName: string;
        toolName: string;
        capabilityType: string;
    };
} | undefined;
