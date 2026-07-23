import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { selectedSkillDisplays } from '../../runner/mcp/context.js';
import { hasSelectedItOpsSkill } from '../../runner/itops-native-tool-surface.js';
import { AuditService } from './itops-audit.js';
import { ItOpsClient, type ItOpsClientConfig } from './itops-client.js';
import { ItOpsToolRegistry } from './itops-tools.js';

export function registerNativeItOpsTools(server: McpServer): void {
  const config = readItOpsClientConfig(process.env);
  new ItOpsToolRegistry(
    new ItOpsClient(config),
    new AuditService(),
  ).registerTools(server);
}

export function readItOpsClientConfig(
  env: NodeJS.ProcessEnv,
): ItOpsClientConfig {
  return {
    itopsApiBaseUrl: env.ITOPS_API_BASE_URL?.trim() || 'http://127.0.0.1:4000',
    itopsApiTimeoutMs: positiveInteger(env.ITOPS_API_TIMEOUT_MS, 15_000),
    itopsApiRetryAttempts: boundedInteger(
      env.ITOPS_API_RETRY_ATTEMPTS,
      2,
      0,
      5,
    ),
    itopsApiRetryDelayMs: boundedInteger(
      env.ITOPS_API_RETRY_DELAY_MS,
      3_000,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(env.ITOPS_API_KEY?.trim()
      ? { itopsApiKey: env.ITOPS_API_KEY.trim() }
      : {}),
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  return boundedInteger(raw, fallback, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}
