export declare function controlApiRequest(runtimeHome: string, input: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
    missingKeyMessage?: string;
}): Promise<unknown>;
