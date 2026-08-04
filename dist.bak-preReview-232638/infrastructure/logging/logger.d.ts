import { Clock } from '../../shared/time/datetime.js';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export interface LogRecord {
    timestamp: string;
    level: LogLevel;
    message: string;
    pid: number;
    context?: Record<string, unknown>;
}
export interface LogSink {
    write: (record: LogRecord) => void;
}
export interface Logger {
    debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
    info: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
    warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
    error: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
    fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
    child: (context: Record<string, unknown>) => Logger;
}
export interface CreateLoggerOptions {
    level?: LogLevel;
    sink?: LogSink;
    format?: 'json' | 'text';
    clock?: Clock;
    context?: Record<string, unknown>;
    redact?: (value: unknown) => unknown;
}
export interface LogCorrelationContext {
    runId?: string;
    appId?: string;
    agentId?: string;
    traceId?: string;
}
export declare function withLogContext<T>(context: LogCorrelationContext, callback: () => T): T;
export declare function updateLogContext(context: LogCorrelationContext): void;
export declare function currentLogContext(): Readonly<LogCorrelationContext> | undefined;
export declare function redactString(value: string): string;
export declare function createLogger(options?: CreateLoggerOptions): Logger;
export declare const logger: Logger;
export declare function installGlobalErrorHandlers(target?: Logger): () => void;
export declare function createLogRecord(level: LogLevel, message: string, context?: Record<string, unknown>, clock?: Clock): LogRecord;
