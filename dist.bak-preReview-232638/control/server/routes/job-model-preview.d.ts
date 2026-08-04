import type { ControlRouteContext } from '../handler-context.js';
export declare function modelPreviewFor(input: {
    explicitAlias?: string;
    kind: 'manual' | 'once' | 'recurring';
    getDefaultModelConfig: ControlRouteContext['getDefaultModelConfig'];
    agentFolder?: string;
}): {
    modelAlias: string | null;
    modelSource: string;
    model: null;
} | {
    modelAlias: string;
    modelSource: string;
    model: {
        displayName: string;
        responseFamily: string;
        modelRoute: {
            id: "anthropic" | "openrouter" | "openai" | "bedrock" | "vertex";
            label: string;
        };
        contextWindowTokens: number | undefined;
        maxOutputTokens: number | undefined;
        cachePolicy: import("../../../shared/model-catalog.js").ModelCacheMode;
    };
};
export declare function resolveCreateJobModel(input: {
    modelAlias: unknown;
    kind: 'manual' | 'once' | 'recurring';
    getDefaultModelConfig: ControlRouteContext['getDefaultModelConfig'];
    agentFolder?: string;
}): {
    modelAlias: string;
    source: string;
    explicit: boolean;
};
