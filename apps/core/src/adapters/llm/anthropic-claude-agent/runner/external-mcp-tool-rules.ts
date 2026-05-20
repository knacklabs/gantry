import { isPublicExternalMcpToolRule } from '../agent-capabilities.js';

export function readExternalMcpAllowedTools(): readonly string[] {
  return readExternalMcpToolRules('GANTRY_MCP_ALLOWED_TOOLS_JSON');
}

export function readExternalMcpAlwaysAllowedTools(): readonly string[] {
  return readExternalMcpToolRules('GANTRY_MCP_ALWAYS_ALLOWED_TOOLS_JSON');
}

function readExternalMcpToolRules(envKey: string): readonly string[] {
  const raw = process.env[envKey]?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is string =>
      typeof entry === 'string' && isPublicExternalMcpToolRule(entry),
  );
}
