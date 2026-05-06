import { Clock, nowIso, systemClock, toIso } from '../time/datetime.js';
import { isPlainObject } from '../../shared/object.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

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

const DEFAULT_REDACT_KEY_PATTERN =
  /(token|secret|password|credential|api[_-]?key|authorization|auth)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9._-]+\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\b(postgres(?:ql)?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
  /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g,
  /([?&](?:password|passwd|pass|token|secret|api[_-]?key)=)[^&\s'"]+/gi,
  /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)=([^\s]+)/gi,
  /"([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)"\s*:\s*"[^"]*"/gi,
  /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)\s*:\s*["']?[^"',\s}]+["']?/gi,
  /\b(PASSWORD\s+)'[^']*'/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+\b/gi,
];
const LOGGER_HANDLER_MARK = Symbol.for('myclaw.logger.handler');

function sanitizeError(err: Error): Record<string, unknown> {
  return {
    type: err.constructor.name,
    message: redactString(err.message),
    stack: err.stack ? redactString(err.stack) : undefined,
  };
}

function defaultRedact(value: unknown): unknown {
  return redactValue(value, 0);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '[TRUNCATED_DEPTH]';
  if (value instanceof Error) return sanitizeError(value);
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DEFAULT_REDACT_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (_match, first) => {
      if (
        typeof first === 'string' &&
        /^(https?|postgres(?:ql)?):\/\//i.test(first)
      ) {
        return `${first}[REDACTED]@`;
      }
      if (typeof first === 'string' && first.startsWith('?')) {
        return `${first}[REDACTED]`;
      }
      if (typeof first === 'string' && first.startsWith('&')) {
        return `${first}[REDACTED]`;
      }
      if (
        typeof first === 'string' &&
        /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)/i.test(first)
      ) {
        return /\s$/.test(first)
          ? `${first}'[REDACTED]'`
          : /:\s*$/.test(first)
            ? `${first}"[REDACTED]"`
            : `${first}=[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return out;
}

function createTextSink(opts: { stderrOnly?: boolean }): LogSink {
  return {
    write(record) {
      const forceStderr = opts.stderrOnly === true;
      const stream =
        forceStderr ||
        LOG_LEVEL_PRIORITY[record.level] >= LOG_LEVEL_PRIORITY.warn
          ? process.stderr
          : process.stdout;
      if (!record.context || Object.keys(record.context).length === 0) {
        stream.write(
          `[${record.timestamp}] ${record.level.toUpperCase()} (${record.pid}): ${record.message}\n`,
        );
        return;
      }
      stream.write(
        `[${record.timestamp}] ${record.level.toUpperCase()} (${record.pid}): ${record.message} ${JSON.stringify(record.context)}\n`,
      );
    },
  };
}

function createJsonSink(opts: { stderrOnly?: boolean }): LogSink {
  return {
    write(record) {
      const forceStderr = opts.stderrOnly === true;
      const stream =
        forceStderr ||
        LOG_LEVEL_PRIORITY[record.level] >= LOG_LEVEL_PRIORITY.warn
          ? process.stderr
          : process.stdout;
      stream.write(`${JSON.stringify(record)}\n`);
    },
  };
}

function mergeContexts(
  left?: Record<string, unknown>,
  right?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!left && !right) return undefined;
  return {
    ...(left || {}),
    ...(right || {}),
  };
}

function normalizeLevel(raw?: string): LogLevel {
  const value = (raw || '').trim().toLowerCase();
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'fatal'
  ) {
    return value;
  }
  return 'info';
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level || normalizeLevel(process.env.LOG_LEVEL);
  const clock = options.clock || systemClock;
  const redact = options.redact || defaultRedact;
  const baseContext = options.context;
  const stderrOnly = process.env.MYCLAW_LOG_STDERR === '1';
  const sink =
    options.sink ||
    (options.format === 'json'
      ? createJsonSink({ stderrOnly })
      : createTextSink({ stderrOnly }));

  const log = (
    currentLevel: LogLevel,
    dataOrMsg: Record<string, unknown> | string,
    msg?: string,
    childContext?: Record<string, unknown>,
  ) => {
    if (LOG_LEVEL_PRIORITY[currentLevel] < LOG_LEVEL_PRIORITY[level]) return;
    const record: LogRecord = {
      timestamp: nowIso(clock),
      level: currentLevel,
      message: typeof dataOrMsg === 'string' ? dataOrMsg : msg || '',
      pid: process.pid,
      ...(() => {
        if (typeof dataOrMsg === 'string') {
          const context = mergeContexts(baseContext, childContext);
          return context ? { context } : {};
        }
        const context = mergeContexts(
          mergeContexts(baseContext, childContext),
          redact(dataOrMsg) as Record<string, unknown>,
        );
        return context ? { context } : {};
      })(),
    };
    sink.write(record);
  };

  const makeChildLogger = (childContext?: Record<string, unknown>): Logger => ({
    debug: (dataOrMsg, msg) => log('debug', dataOrMsg, msg, childContext),
    info: (dataOrMsg, msg) => log('info', dataOrMsg, msg, childContext),
    warn: (dataOrMsg, msg) => log('warn', dataOrMsg, msg, childContext),
    error: (dataOrMsg, msg) => log('error', dataOrMsg, msg, childContext),
    fatal: (dataOrMsg, msg) => log('fatal', dataOrMsg, msg, childContext),
    child: (nextContext) =>
      makeChildLogger(mergeContexts(childContext, nextContext)),
  });

  return makeChildLogger();
}

export const logger = createLogger({
  format: process.env.LOG_FORMAT === 'json' ? 'json' : 'text',
});

type MarkedUncaughtExceptionHandler = ((err: Error) => void) & {
  [LOGGER_HANDLER_MARK]?: true;
};

type MarkedUnhandledRejectionHandler = ((
  reason: unknown,
  promise: Promise<unknown>,
) => void) & {
  [LOGGER_HANDLER_MARK]?: true;
};

function removeMarkedProcessListeners(
  event: 'uncaughtException' | 'unhandledRejection',
): void {
  if (event === 'uncaughtException') {
    for (const listener of process.listeners(
      event,
    ) as MarkedUncaughtExceptionHandler[]) {
      if (listener[LOGGER_HANDLER_MARK]) {
        process.removeListener(event, listener);
      }
    }
    return;
  }
  for (const listener of process.listeners(
    event,
  ) as MarkedUnhandledRejectionHandler[]) {
    if (listener[LOGGER_HANDLER_MARK]) {
      process.removeListener(event, listener);
    }
  }
}

export function installGlobalErrorHandlers(
  target: Logger = logger,
): () => void {
  removeMarkedProcessListeners('uncaughtException');
  removeMarkedProcessListeners('unhandledRejection');

  const uncaughtExceptionHandler = ((err: Error) => {
    target.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  }) as MarkedUncaughtExceptionHandler;
  uncaughtExceptionHandler[LOGGER_HANDLER_MARK] = true;

  const unhandledRejectionHandler = ((reason: unknown) => {
    target.error({ err: reason }, 'Unhandled rejection');
  }) as MarkedUnhandledRejectionHandler;
  unhandledRejectionHandler[LOGGER_HANDLER_MARK] = true;

  process.on('uncaughtException', uncaughtExceptionHandler);
  process.on('unhandledRejection', unhandledRejectionHandler);

  return () => {
    process.removeListener('uncaughtException', uncaughtExceptionHandler);
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
  };
}

export function createLogRecord(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
  clock: Clock = systemClock,
): LogRecord {
  return {
    level,
    message,
    pid: process.pid,
    timestamp: toIso(clock.now()),
    ...(context ? { context } : {}),
  };
}
