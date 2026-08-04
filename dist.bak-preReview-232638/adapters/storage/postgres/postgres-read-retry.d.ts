export declare function isRetryablePostgresReadError(error: unknown): boolean;
export declare function retryPostgresRead<T>(operationName: string, operation: () => Promise<T>, options?: {
    delaysMs?: readonly number[];
}): Promise<T>;
