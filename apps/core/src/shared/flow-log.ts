// Opt-in, structured "flow" logging for tracing one message across the runtime
// boundaries (guardrail -> LLM -> MCP -> outbound). Off by default so production
// logs are unaffected; enable with GANTRY_FLOW_LOG=1 in $GANTRY_HOME/.env (or the
// process env). Lines carry a stable `flow` tag plus correlation fields (chatJid,
// messageId) so a test harness can stitch a single conversation turn together.
//
// This file lives in the `shared` layer, which may not import `config` or
// `infrastructure`. It therefore reads the flag from process.env (a Node global)
// — the value is hydrated from $GANTRY_HOME/.env at startup
// (see app/index.ts -> hydrateDynamicRuntimeEnv) — and accepts a structural
// logger rather than importing the concrete Logger type.
const FLOW_LOG_ENV = 'GANTRY_FLOW_LOG';

type FlowLogger = {
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
};

export function isFlowLogEnabled(): boolean {
  return process.env[FLOW_LOG_ENV] === '1';
}

export function flowLog(
  logger: FlowLogger,
  event: string,
  fields: Record<string, unknown>,
): void {
  if (!isFlowLogEnabled()) return;
  logger.info({ flow: event, ...fields }, `flow:${event}`);
}
