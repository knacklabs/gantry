import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import {
  hashMcpAuditValue,
  projectMcpEvidence,
  summarizeMcpToolArgumentPayload,
} from '../../../../application/mcp/mcp-tool-audit.js';
import {
  EXTERNAL_MCP_AUDIT_FILE_ENV,
  EXTERNAL_MCP_AUDIT_PREFIX,
} from './external-mcp-audit-protocol.js';

type PendingCall = {
  receiptId: string;
  startedAt: number;
  toolInput: unknown;
  toolName: string;
};

const [, , serverName, command, ...args] = process.argv;
if (!serverName || !command) {
  process.stderr.write('Usage: audited-external-mcp-proxy <server> <command> [...args]\n');
  process.exit(2);
}

const child = spawn(command, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map<string, PendingCall>();
let inputBuffer = '';
let outputBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuffer = forwardLines(inputBuffer + chunk, (line) => {
    const message = parseRecord(line);
    if (message?.method === 'tools/call' && message.id != null) {
      const params = record(message.params);
      pending.set(String(message.id), {
        receiptId: randomUUID(),
        startedAt: Date.now(),
        toolInput: params.arguments,
        toolName: typeof params.name === 'string' ? params.name : 'unknown',
      });
    }
    child.stdin.write(`${line}\n`);
  });
});
process.stdin.on('end', () => child.stdin.end());

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  outputBuffer = forwardLines(outputBuffer + chunk, (line) => {
    const message = parseRecord(line);
    const call = message?.id == null ? null : pending.get(String(message.id));
    if (!message || !call) {
      process.stdout.write(`${line}\n`);
      return;
    }
    pending.delete(String(message.id));
    const failed = Boolean(message.error) || record(message.result).isError === true;
    const toolResponse = message.result ?? message.error;
    if (message.result && typeof message.result === 'object') {
      const result = record(message.result);
      const content = Array.isArray(result.content) ? result.content : [];
      message.result = {
        ...result,
        content: [
          ...content,
          {
            type: 'text',
            text: JSON.stringify({
              gantryProvenance: { toolCallId: call.receiptId },
            }),
          },
        ],
      };
    } else if (message.error && typeof message.error === 'object') {
      const error = record(message.error);
      message.error = {
        ...error,
        data: {
          ...record(error.data),
          gantryProvenance: { toolCallId: call.receiptId },
        },
      };
    }
    const payload = {
      toolCallId: call.receiptId,
      serverName,
      toolName: call.toolName,
      requestedToolRule: `mcp__${serverName}__${call.toolName}`,
      resultClass: failed ? 'failure' : 'success',
      latencyMs: Math.max(0, Date.now() - call.startedAt),
      argumentSummary: summarizeMcpToolArgumentPayload(call.toolInput),
      inputHash: hashMcpAuditValue(call.toolInput),
      ...(failed
        ? { error: { message: 'MCP tool call failed.' } }
        : {
            resultHash: hashMcpAuditValue(toolResponse),
            evidenceProjection: projectMcpEvidence(toolResponse),
          }),
    };
    const auditLine = `${JSON.stringify(payload)}\n`;
    const auditFilePath = process.env[EXTERNAL_MCP_AUDIT_FILE_ENV]?.trim();
    if (auditFilePath) fs.appendFileSync(auditFilePath, auditLine);
    process.stderr.write(`${EXTERNAL_MCP_AUDIT_PREFIX}${auditLine}`);
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
});

child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
child.on('error', (error) => {
  process.stderr.write(`External MCP process failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (outputBuffer) process.stdout.write(outputBuffer);
  process.exitCode = code ?? (signal ? 1 : 0);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

function forwardLines(
  value: string,
  handle: (line: string) => void,
): string {
  const lines = value.split('\n');
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) handle(line);
  }
  return remainder;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
