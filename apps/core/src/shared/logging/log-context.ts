export type LogFields = Record<string, unknown>;

export interface LogContext {
  fields?: LogFields;
  correlationId?: string;
}
