import { and, eq, inArray } from 'drizzle-orm';

import {
  canonicalStringSet,
  McpBindingAuthorityChangedError,
  type McpBindingAuthorityPrecondition,
} from '../../../../domain/mcp/mcp-servers.js';
import type { AgentId } from '../../../../domain/agent/agent.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

export async function assertExpectedMcpBindingsUnchanged(
  db: CanonicalExecutor,
  input: {
    appId: string;
    expectedMcpBindingAgentIds?: AgentId[];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
  },
): Promise<void> {
  const expected = input.expectedMcpBindings ?? [];
  const agentIds = [
    ...new Set(
      input.expectedMcpBindingAgentIds ??
        expected.map((binding) => binding.agentId),
    ),
  ].sort();
  if (agentIds.length === 0) return;
  for (const agentId of agentIds) {
    await lockAgentMcpBindingSet(db, { appId: input.appId, agentId });
  }
  const rows = await db
    .select()
    .from(pgSchema.agentMcpServerBindingsPostgres)
    .where(
      and(
        eq(pgSchema.agentMcpServerBindingsPostgres.appId, input.appId),
        inArray(pgSchema.agentMcpServerBindingsPostgres.agentId, agentIds),
      ),
    )
    .for('update');
  const expectedById = new Map(
    expected.map((binding) => [String(binding.id), binding]),
  );
  if (rows.length !== expectedById.size) {
    throw new McpBindingAuthorityChangedError(
      rows.find((row) => !expectedById.has(String(row.id)))?.serverId ??
        expected[0]?.serverId ??
        (`agent:${agentIds[0]}` as never),
    );
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const binding of expected) {
    const row = byId.get(String(binding.id));
    if (
      !row ||
      row.appId !== binding.appId ||
      row.agentId !== binding.agentId ||
      row.serverId !== binding.serverId ||
      row.status !== binding.status ||
      row.required !== binding.required ||
      !jsonStringSetEquals(
        row.permissionPolicyIdsJson,
        binding.permissionPolicyIds,
      ) ||
      !jsonStringSetEquals(
        row.allowedToolPatternsJson,
        binding.allowedToolPatterns,
      ) ||
      (row.conversationId ?? undefined) !== binding.conversationId ||
      (row.threadId ?? undefined) !== binding.threadId
    ) {
      throw new McpBindingAuthorityChangedError(binding.serverId);
    }
  }
}

export async function lockAgentMcpBindingSet(
  db: CanonicalExecutor,
  input: { appId: string; agentId: string },
): Promise<void> {
  await db
    .select({ id: pgSchema.agentsPostgres.id })
    .from(pgSchema.agentsPostgres)
    .where(
      and(
        eq(pgSchema.agentsPostgres.appId, input.appId),
        eq(pgSchema.agentsPostgres.id, input.agentId),
      ),
    )
    .for('update');
}

function jsonStringSetEquals(
  encoded: string,
  expected: readonly string[],
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.every((value) => typeof value === 'string') &&
    JSON.stringify(canonicalStringSet(parsed)) ===
      JSON.stringify(canonicalStringSet(expected))
  );
}
