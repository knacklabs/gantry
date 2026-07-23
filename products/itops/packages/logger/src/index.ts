type LogContext = Record<string, unknown>;

export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export function createLogger(service: string): Logger {
  const write = (level: "info" | "warn" | "error", message: string, context: LogContext = {}): void => {
    const payload = {
      level,
      service,
      message,
      ...context,
      timestamp: new Date().toISOString()
    };

    console[level](JSON.stringify(payload));
  };

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context)
  };
}
