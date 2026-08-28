import type { AgentMcpServerBinding } from '../../../../domain/mcp/mcp-servers.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import * as pgSchema from '../schema/schema.js';
import { lockAgentMcpBindingSet } from './mcp-binding-authority-fence.postgres.js';

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Persist one attachment set atomically; callers have already applied policy. */
export async function saveMcpAgentBindingsBatch(
  db: CanonicalDb,
  bindings: AgentMcpServerBinding[],
): Promise<void> {
  if (bindings.length === 0) return;
  await db.transaction(async (tx) => {
    for (const binding of [...bindings].sort((left, right) =>
      String(left.agentId).localeCompare(String(right.agentId)),
    )) {
      await lockAgentMcpBindingSet(tx, binding);
    }
    for (const binding of bindings) {
      await tx
        .insert(pgSchema.agentMcpServerBindingsPostgres)
        .values({
          id: binding.id,
          appId: binding.appId,
          agentId: binding.agentId,
          serverId: binding.serverId,
          status: binding.status,
          required: binding.required,
          permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
          allowedToolPatternsJson: encodeJson(binding.allowedToolPatterns),
          conversationId: binding.conversationId ?? null,
          threadId: binding.threadId ?? null,
          createdAt: binding.createdAt,
          updatedAt: binding.updatedAt,
        })
        .onConflictDoUpdate({
          target: pgSchema.agentMcpServerBindingsPostgres.id,
          set: {
            status: binding.status,
            required: binding.required,
            permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
            allowedToolPatternsJson: encodeJson(binding.allowedToolPatterns),
            conversationId: binding.conversationId ?? null,
            threadId: binding.threadId ?? null,
            updatedAt: binding.updatedAt,
          },
        });
    }
  });
}
