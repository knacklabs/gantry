import path from 'node:path';

export const EXTERNAL_MCP_AUDIT_PREFIX = 'GANTRY_EXTERNAL_MCP_AUDIT ';
export const EXTERNAL_MCP_AUDIT_FILE_ENV =
  'GANTRY_EXTERNAL_MCP_AUDIT_FILE';

export function externalMcpAuditFilePath(): string | undefined {
  const ipcDir = process.env.GANTRY_IPC_DIR?.trim();
  return ipcDir ? path.join(ipcDir, 'external-mcp-audit.jsonl') : undefined;
}
