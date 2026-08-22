import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { redactSensitiveText } from '../../shared/sensitive-material.js';
import { CAPABILITY_RUN_MAX_ARGS } from '../../shared/structured-local-cli.js';
import { nowIso } from '../../shared/time/datetime.js';
import { ApplicationError } from '../common/application-error.js';

export type McpToolAuditResultClass =
  | 'attempt'
  | 'invalid_request'
  | 'denied'
  | 'success'
  | 'timeout'
  | 'failure';

export function summarizeMcpToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(args).sort();
  return {
    kind: 'object',
    keyCount: keys.length,
    keys: keys.slice(0, 20),
    truncated: keys.length > 20,
    approxBytes: approximateJsonBytes(args),
  };
}

export function summarizeMcpToolArgumentPayload(
  value: unknown,
): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return summarizeMcpToolArguments(value as Record<string, unknown>);
  }
  return {
    kind:
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    keyCount: 0,
    keys: [],
    truncated: false,
    approxBytes: approximateJsonBytes(value),
  };
}

export function summarizeCapabilityRunAudit(input: {
  serverName?: string;
  toolName?: string;
  argumentPayload?: unknown;
  toolResult?: unknown;
}):
  | {
      capabilityId: string;
      argCount: number;
      args?: string[];
      stdout: string;
      stderr: string;
    }
  | undefined {
  if (
    input.serverName !== 'gantry' ||
    input.toolName !== 'capability_run' ||
    !isCapabilityRunInput(input.argumentPayload)
  ) {
    return undefined;
  }
  const output = capabilityRunOutput(input.toolResult);
  return {
    capabilityId: redactAndTruncateCapabilityAuditText(
      input.argumentPayload.capabilityId,
    ),
    argCount: input.argumentPayload.args.length,
    // Raw argv can carry credentials in positions no fixed rule can detect
    // (short flags, custom flags, positional secrets), so it is logged only when
    // an operator opts in for a capability they trust. Best-effort redaction
    // still applies as defense in depth.
    ...(capabilityAuditArgsEnabled()
      ? {
          args: redactCapabilityArgv(
            input.argumentPayload.args.slice(0, CAPABILITY_RUN_MAX_ARGS),
          ),
        }
      : {}),
    stdout: redactAndTruncateCapabilityAuditText(output.stdout),
    stderr: redactAndTruncateCapabilityAuditText(output.stderr),
  };
}

function capabilityAuditArgsEnabled(): boolean {
  const raw = process.env.GANTRY_AUDIT_CAPABILITY_ARGS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export async function publishInvalidMcpToolRequestAudit(input: {
  mcpServers: McpServerRepository;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  appId: AppId;
  agentId: AgentId;
  runId?: string;
  runHandle?: string;
  serverName?: string;
  toolName?: string;
  argumentPayload?: unknown;
  reason: string;
  missingFields?: string[];
}): Promise<void> {
  const reason = truncateAuditText(redactMcpAuditText(input.reason), 300);
  const capabilityRun = summarizeCapabilityRunAudit({
    serverName: input.serverName,
    toolName: input.toolName,
    argumentPayload: input.argumentPayload,
  });
  const payload = {
    ...(input.serverName ? { serverName: input.serverName } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.serverName && input.toolName
      ? { requestedToolRule: `mcp__${input.serverName}__${input.toolName}` }
      : {}),
    resultClass: 'invalid_request' satisfies McpToolAuditResultClass,
    latencyMs: 0,
    argumentSummary: summarizeMcpToolArgumentPayload(input.argumentPayload),
    ...(capabilityRun ? { capabilityRun } : {}),
    reason,
    ...(input.missingFields && input.missingFields.length > 0
      ? { missingFields: input.missingFields }
      : {}),
    ...(input.runHandle ? { runHandle: input.runHandle } : {}),
  };
  await input.mcpServers.appendAuditEvent({
    id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
    appId: input.appId,
    agentId: input.agentId,
    eventType: 'tool_activity',
    actorId: 'mcp-tool-handler',
    reason,
    metadata: payload,
    createdAt: nowIso() as never,
  });
  if (!input.publishRuntimeEvent) return;
  try {
    await input.publishRuntimeEvent({
      appId: input.appId,
      agentId: input.agentId,
      ...(input.runId ? { runId: input.runId as AgentRunId } : {}),
      eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
      actor: 'mcp-tool-handler',
      responseMode: 'none',
      payload,
    });
  } catch {
    // Durable MCP audit is the source of truth; runtime events are observable
    // progress only and must not rewrite a malformed request outcome.
  }
}

function isCapabilityRunInput(
  value: unknown,
): value is { capabilityId: string; args: string[] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { capabilityId?: unknown }).capabilityId === 'string' &&
    Array.isArray((value as { args?: unknown }).args) &&
    (value as { args: unknown[] }).args.every((arg) => typeof arg === 'string')
  );
}

function capabilityRunOutput(value: unknown): {
  stdout: string;
  stderr: string;
} {
  const result = objectRecord(value);
  const directOutput = result
    ? (objectRecord(result.content) ?? result)
    : undefined;
  if (
    typeof directOutput?.stdout === 'string' ||
    typeof directOutput?.stderr === 'string'
  ) {
    return {
      stdout:
        typeof directOutput.stdout === 'string' ? directOutput.stdout : '',
      stderr:
        typeof directOutput.stderr === 'string' ? directOutput.stderr : '',
    };
  }
  const content = result?.content;
  if (!Array.isArray(content)) return { stdout: '', stderr: '' };
  const text = content.find(
    (entry): entry is { type: unknown; text: unknown } =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
  if (!text || typeof text.text !== 'string') return { stdout: '', stderr: '' };
  try {
    return capabilityRunOutput(JSON.parse(text.text));
  } catch {
    return { stdout: '', stderr: '' };
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function redactAndTruncateCapabilityAuditText(value: string): string {
  return truncateAuditText(redactMcpAuditText(value), 2_000);
}

// A secret passed as `--password supersecret` splits across two argv entries, so
// the value alone carries no key context for the text redactor. Redact the entry
// that follows a sensitive option flag before it can reach a durable log.
const SENSITIVE_CAPABILITY_OPTION =
  /^--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|secret|client[_-]?secret|private[_-]?key|session[_-]?id|token|credential|auth(?:orization)?)$/i;

function redactCapabilityArgv(args: string[]): string[] {
  const redacted: string[] = [];
  let expectSensitiveValue = false;
  for (const arg of args) {
    // A sensitive flag's value is the next NON-flag entry. The pending state is
    // kept across any intervening flags (sensitive or not) and only consumed by
    // the next value, so `--password --verbose supersecret` and
    // `--password --token realtoken` both redact the real value.
    if (expectSensitiveValue && !arg.startsWith('-')) {
      redacted.push('[REDACTED_SECRET]');
      expectSensitiveValue = false;
      continue;
    }
    expectSensitiveValue =
      SENSITIVE_CAPABILITY_OPTION.test(arg) ||
      (expectSensitiveValue && arg.startsWith('-'));
    redacted.push(redactAndTruncateCapabilityAuditText(arg));
  }
  return redacted;
}

export function classifyMcpToolAuditError(
  err: unknown,
): McpToolAuditResultClass {
  if (err instanceof ApplicationError && err.code === 'FORBIDDEN') {
    return 'denied';
  }
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  const name = err instanceof Error ? err.name.toLowerCase() : '';
  return name.includes('timeout') ||
    name.includes('abort') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
    ? 'timeout'
    : 'failure';
}

export function summarizeMcpToolError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: truncateAuditText(redactMcpAuditText(err.message), 300),
    };
  }
  return { message: truncateAuditText(redactMcpAuditText(String(err)), 300) };
}

function approximateJsonBytes(value: unknown): number | 'unavailable' {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 'unavailable';
  }
}

function truncateAuditText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function redactMcpAuditText(value: string): string {
  return redactSensitiveText(value).replace(
    /\b(token|secret|password|api[_-]?key|authorization)\s*=\s*[^\s,;]+/gi,
    '$1=[REDACTED_SECRET]',
  );
}
