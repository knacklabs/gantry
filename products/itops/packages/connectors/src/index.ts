export interface ConnectorResult {
  ok: boolean;
  externalId?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export * from "./google-workspace/index.js";
export * from "./slack/index.js";
