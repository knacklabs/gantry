export declare function nowIso(): string;
export declare function withStatementTimeout<T>(db: any, timeoutMs: number | undefined, statementTimeoutSql: (timeoutMs: number) => unknown, work: (db: any) => Promise<T>): Promise<T>;
