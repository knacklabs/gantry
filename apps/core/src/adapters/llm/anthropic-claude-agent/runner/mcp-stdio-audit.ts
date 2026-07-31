import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '../agent-capabilities.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import {
  hashMcpAuditValue,
  projectMcpEvidence,
  summarizeMcpToolArgumentPayload,
} from '../../../../application/mcp/mcp-tool-audit.js';
import { writeOutput } from './output.js';
import type { AgentRunnerInput } from './types.js';

const AUDIT_FILE_ENV = 'GANTRY_MCP_STDIO_AUDIT_FILE';
const SERVER_NAME_ENV = 'GANTRY_MCP_STDIO_AUDIT_SERVER_NAME';

export interface ExternalMcpAuditRecord {
  toolCallId: string;
  serverName: string;
  toolName: string;
  requestedToolRule: string;
  resultClass: 'attempt' | 'success' | 'failure';
  latencyMs: number;
  argumentSummary: Record<string, unknown>;
  inputHash: string;
  resultHash?: string;
  evidenceProjection?: Array<{ path: string; value: string }>;
  error?: { message: string };
}

export interface ExternalMcpStdioAudit {
  mcpServers: Record<string, McpServerConfig>;
  auditFile?: string;
  drain: () => ExternalMcpAuditRecord[];
  cleanup: () => void;
}

export function appendSdkMcpAuditActivity(input: {
  auditFile: string | undefined;
  serverNames: readonly string[];
  hook: {
    hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    tool_response?: unknown;
    error?: string;
    duration_ms?: number;
  };
}): void {
  if (!input.auditFile) return;
  const serverName = input.serverNames
    .filter((name) => name !== 'gantry')
    .sort((left, right) => right.length - left.length)
    .find((name) => input.hook.tool_name.startsWith(`mcp__${name}__`));
  if (!serverName) return;
  const toolName = input.hook.tool_name.slice(`mcp__${serverName}__`.length);
  const resultClass =
    input.hook.hook_event_name === 'PreToolUse'
      ? 'attempt'
      : input.hook.hook_event_name === 'PostToolUse'
        ? 'success'
        : 'failure';
  const record: ExternalMcpAuditRecord = {
    toolCallId: input.hook.tool_use_id,
    serverName,
    toolName,
    requestedToolRule: input.hook.tool_name,
    resultClass,
    latencyMs: Math.max(0, input.hook.duration_ms ?? 0),
    argumentSummary: summarizeMcpToolArgumentPayload(input.hook.tool_input),
    inputHash: hashMcpAuditValue(input.hook.tool_input),
    ...(resultClass === 'success'
      ? {
          resultHash: hashMcpAuditValue(input.hook.tool_response),
          evidenceProjection: projectMcpEvidence(input.hook.tool_response),
        }
      : {}),
    ...(resultClass === 'failure'
      ? { error: { message: 'MCP tool call failed.' } }
      : {}),
  };
  appendFileSync(input.auditFile, `${JSON.stringify(record)}\n`, 'utf8');
}

export function createExternalMcpAuditHook(
  audit: ExternalMcpStdioAudit,
  eventName: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== eventName) return { continue: true };
    appendSdkMcpAuditActivity({
      auditFile: audit.auditFile,
      serverNames: Object.keys(audit.mcpServers),
      hook: hookInput,
    });
    if (hookInput.hook_event_name !== 'PostToolUse') {
      return { continue: true };
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: mcpToolOutputWithProvenance(
          hookInput.tool_response,
          hookInput.tool_use_id,
        ),
      },
    };
  };
}

export function flushExternalMcpAudit(
  audit: ExternalMcpStdioAudit,
  agentInput: AgentRunnerInput,
): void {
  for (const payload of audit.drain()) {
    writeOutput({
      status: 'success',
      result: null,
      runtimeEventOnly: true,
      runtimeEvents: [
        {
          appId: agentInput.appId,
          agentId: agentInput.agentId,
          runId: agentInput.runId,
          jobId: agentInput.jobId,
          conversationId: agentInput.chatJid,
          threadId: agentInput.threadId,
          eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
          actor: 'mcp-stdio-audit-proxy',
          responseMode: 'none',
          payload,
        },
      ],
    });
  }
}

export function mcpToolOutputWithProvenance(
  toolResponse: unknown,
  toolCallId: string,
): unknown {
  const provenance = {
    type: 'text',
    text: JSON.stringify({ gantryProvenance: { toolCallId } }),
  };
  if (Array.isArray(toolResponse)) return [...toolResponse, provenance];
  if (toolResponse && typeof toolResponse === 'object') {
    const response = toolResponse as Record<string, unknown>;
    if (Array.isArray(response.content)) {
      return { ...response, content: [...response.content, provenance] };
    }
  }
  return toolResponse;
}

export function createJsonRpcFrameObserver(
  observer: (value: unknown) => void,
): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0);

  const observeJson = (bytes: Buffer) => {
    const raw = bytes.toString('utf8');
    const text = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
    if (!text) return;
    observer(JSON.parse(text));
  };

  return (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length > 0) {
      while (buffered[0] === 10 || buffered[0] === 13) {
        buffered = buffered.subarray(1);
      }
      if (buffered.length === 0) return;

      const prefix = buffered.subarray(0, 15).toString('ascii');
      if (
        prefix.length < 'content-length:'.length &&
        'content-length:'.startsWith(prefix.toLowerCase())
      ) {
        return;
      }
      if (/^content-length:/iu.test(prefix)) {
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = buffered.subarray(0, headerEnd).toString('ascii');
        const match = /^content-length:\s*(\d+)\s*$/imu.exec(header);
        if (!match) throw new Error('Invalid Content-Length MCP frame.');
        const contentLength = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffered.length < bodyStart + contentLength) return;
        observeJson(buffered.subarray(bodyStart, bodyStart + contentLength));
        buffered = buffered.subarray(bodyStart + contentLength);
        continue;
      }

      const lineEnd = buffered.indexOf(10);
      if (lineEnd >= 0) {
        observeJson(buffered.subarray(0, lineEnd));
        buffered = buffered.subarray(lineEnd + 1);
        continue;
      }

      try {
        observeJson(buffered);
        buffered = Buffer.alloc(0);
      } catch {
        return;
      }
    }
  };
}

function isAuditRecord(value: unknown): value is ExternalMcpAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ExternalMcpAuditRecord>;
  return (
    typeof record.toolCallId === 'string' &&
    typeof record.serverName === 'string' &&
    typeof record.toolName === 'string' &&
    typeof record.requestedToolRule === 'string' &&
    (record.resultClass === 'attempt' ||
      record.resultClass === 'success' ||
      record.resultClass === 'failure') &&
    typeof record.latencyMs === 'number' &&
    Boolean(record.argumentSummary) &&
    typeof record.inputHash === 'string'
  );
}

export function prepareExternalMcpStdioAudit(input: {
  mcpServers: Record<string, McpServerConfig>;
  workspaceDir: string;
  runId: string;
}): ExternalMcpStdioAudit {
  const auditable = Object.entries(input.mcpServers).filter(
    ([serverName, config]) =>
      serverName !== 'gantry' && (!config.type || config.type === 'stdio'),
  );
  if (auditable.length === 0) {
    return {
      mcpServers: input.mcpServers,
      drain: () => [],
      cleanup: () => undefined,
    };
  }

  const auditFile = join(
    input.workspaceDir,
    '.llm-runtime',
    'claude',
    'mcp-audit',
    `${input.runId}.jsonl`,
  );
  mkdirSync(dirname(auditFile), { recursive: true });
  writeFileSync(auditFile, '', { flag: 'wx' });
  const proxyPath = fileURLToPath(
    new URL('./mcp-stdio-audit-proxy.js', import.meta.url),
  );
  let consumedCharacters = 0;
  let partialLine = '';

  const drain = (): ExternalMcpAuditRecord[] => {
    const contents = readFileSync(auditFile, 'utf8');
    const appended = contents.slice(consumedCharacters);
    consumedCharacters = contents.length;
    const lines = `${partialLine}${appended}`.split(/\r?\n/u);
    partialLine = lines.pop() ?? '';
    return lines.filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isAuditRecord(parsed)) {
        throw new Error('Invalid stdio MCP audit record.');
      }
      return parsed;
    });
  };

  const mcpServers = Object.fromEntries(
    Object.entries(input.mcpServers).map(([serverName, config]) => {
      if (serverName === 'gantry' || (config.type && config.type !== 'stdio')) {
        return [serverName, config];
      }
      return [
        serverName,
        {
          ...config,
          command: process.execPath,
          args: [proxyPath, config.command, ...(config.args ?? [])],
          env: {
            ...(config.env ?? {}),
            PATH: process.env.PATH,
            [AUDIT_FILE_ENV]: auditFile,
            [SERVER_NAME_ENV]: serverName,
          },
        },
      ];
    }),
  ) as Record<string, McpServerConfig>;
  const gantryServer = mcpServers.gantry;
  if (gantryServer && 'command' in gantryServer) {
    mcpServers.gantry = {
      ...gantryServer,
      env: {
        ...(gantryServer.env ?? {}),
        [AUDIT_FILE_ENV]: auditFile,
      },
    };
  }

  return {
    mcpServers,
    auditFile,
    drain,
    cleanup: () => rmSync(auditFile, { force: true }),
  };
}
