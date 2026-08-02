import type {
  AgentMcpAccessSnapshot,
  AgentSkillAccessSnapshot,
  AgentToolAccessSnapshot,
} from '../../domain/ports/repositories.js';

export interface AgentAccessSnapshot {
  appId: string;
  agentId: string;
  tools: AgentToolAccessSnapshot;
  skills: AgentSkillAccessSnapshot;
  mcp: AgentMcpAccessSnapshot;
}

export function assertHostAccessSnapshot(input: {
  accessSnapshot?: AgentAccessSnapshot;
  appId: string;
  agentId: string;
  subject: string;
}): AgentAccessSnapshot | undefined {
  const snapshot = input.accessSnapshot;
  if (!snapshot) return undefined;
  if (snapshot.appId !== input.appId || snapshot.agentId !== input.agentId) {
    throw new Error(`${input.subject} access snapshot owner mismatch.`);
  }
  assertToolSnapshotRows(snapshot, input);
  assertSkillSnapshotRows(snapshot, input);
  assertMcpSnapshotRows(snapshot, input);
  return snapshot;
}

function assertToolSnapshotRows(
  snapshot: AgentAccessSnapshot,
  input: { appId: string; agentId: string; subject: string },
): void {
  for (const row of snapshot.tools.activeBindings) {
    const definition = row.definition;
    if (
      String(row.binding.appId) !== input.appId ||
      String(row.binding.agentId) !== input.agentId ||
      row.binding.status !== 'active' ||
      (definition &&
        (String(row.binding.toolId) !== String(definition.id) ||
          String(definition.appId) !== input.appId))
    ) {
      throw new Error(`${input.subject} tool snapshot row owner mismatch.`);
    }
  }
  for (const definition of snapshot.tools.appActiveDefinitions) {
    if (
      String(definition.appId) !== input.appId ||
      definition.status !== 'active'
    ) {
      throw new Error(
        `${input.subject} tool snapshot definition owner mismatch.`,
      );
    }
  }
}

function assertSkillSnapshotRows(
  snapshot: AgentAccessSnapshot,
  input: { appId: string; agentId: string; subject: string },
): void {
  for (const row of snapshot.skills.activeBindings) {
    const definition = row.definition;
    if (
      String(row.binding.appId) !== input.appId ||
      String(row.binding.agentId) !== input.agentId ||
      row.binding.status !== 'active' ||
      (definition &&
        (String(row.binding.skillId) !== String(definition.id) ||
          String(definition.appId) !== input.appId ||
          (definition.agentId && String(definition.agentId) !== input.agentId)))
    ) {
      throw new Error(`${input.subject} skill snapshot row owner mismatch.`);
    }
  }
  for (const definition of snapshot.skills.enabledDefinitions) {
    if (
      String(definition.appId) !== input.appId ||
      definition.status !== 'installed' ||
      (definition.agentId && String(definition.agentId) !== input.agentId)
    ) {
      throw new Error(
        `${input.subject} skill snapshot definition owner mismatch.`,
      );
    }
  }
}

function assertMcpSnapshotRows(
  snapshot: AgentAccessSnapshot,
  input: { appId: string; agentId: string; subject: string },
): void {
  for (const row of snapshot.mcp.activeBindings) {
    const definition = row.definition;
    if (
      String(row.binding.appId) !== input.appId ||
      String(row.binding.agentId) !== input.agentId ||
      row.binding.status !== 'active' ||
      (definition &&
        (String(row.binding.serverId) !== String(definition.id) ||
          String(definition.appId) !== input.appId))
    ) {
      throw new Error(`${input.subject} MCP snapshot row owner mismatch.`);
    }
  }
  for (const server of snapshot.mcp.materializedServers) {
    if (
      String(server.definition.appId) !== input.appId ||
      server.definition.status !== 'active' ||
      String(server.binding.appId) !== input.appId ||
      String(server.binding.agentId) !== input.agentId ||
      server.binding.status !== 'active' ||
      String(server.binding.serverId) !== String(server.definition.id)
    ) {
      throw new Error(
        `${input.subject} MCP materialized snapshot row owner mismatch.`,
      );
    }
  }
}
