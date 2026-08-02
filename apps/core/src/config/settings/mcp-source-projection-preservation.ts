import type { AgentId } from '../../domain/agent/agent.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type { McpBindingAuthorityPrecondition } from '../../domain/mcp/mcp-servers.js';
import type {
  RuntimeConfiguredAgentSourceRef,
  RuntimeSettings,
} from './runtime-settings-types.js';

export type PendingMcpSourceEdit = {
  agentFolder: string;
  serverId: string;
  original?: RuntimeConfiguredAgentSourceRef;
  preserveAbsent?: boolean;
  preserveStatus?: boolean;
  preserveTools?: boolean;
};

export function capturePendingMcpSourceEdits(input: {
  settings: RuntimeSettings;
  agentIds: readonly AgentId[] | undefined;
  bindings: readonly McpBindingAuthorityPrecondition[] | undefined;
}): PendingMcpSourceEdit[] {
  const fencedAgentIds = new Set(input.agentIds ?? []);
  if (fencedAgentIds.size === 0) return [];
  const bindingsByAgentAndServer = new Map(
    (input.bindings ?? []).map((binding) => [
      `${binding.agentId}\0${binding.serverId}`,
      binding,
    ]),
  );
  const edits: PendingMcpSourceEdit[] = [];
  for (const [agentFolder, agent] of Object.entries(input.settings.agents)) {
    const agentId = agentIdForFolder(agentFolder);
    if (!fencedAgentIds.has(agentId)) continue;
    const sourceByServerId = new Map(
      agent.sources.mcpServers.map((source) => [source.id, source]),
    );
    const serverIds = new Set([
      ...sourceByServerId.keys(),
      ...(input.bindings ?? [])
        .filter((binding) => binding.agentId === agentId)
        .map((binding) => String(binding.serverId)),
    ]);
    for (const serverId of serverIds) {
      const source = sourceByServerId.get(serverId);
      const binding = bindingsByAgentAndServer.get(`${agentId}\0${serverId}`);
      if (!binding) {
        if (source) {
          edits.push({
            agentFolder,
            serverId,
            original: structuredClone(source),
            preserveStatus: true,
            preserveTools: true,
          });
        }
        continue;
      }
      if (!source) {
        if (binding.status === 'active') {
          edits.push({ agentFolder, serverId, preserveAbsent: true });
        }
        continue;
      }
      const preserveStatus = (source.status ?? 'active') !== binding.status;
      const preserveTools =
        canonicalStrings(source.tools ?? []) !==
        canonicalStrings(binding.allowedToolPatterns);
      if (preserveStatus || preserveTools) {
        edits.push({
          agentFolder,
          serverId,
          original: structuredClone(source),
          preserveStatus,
          preserveTools,
        });
      }
    }
  }
  return edits;
}

export function restorePendingMcpSourceEdits(
  settings: RuntimeSettings,
  edits: readonly PendingMcpSourceEdit[],
): void {
  for (const edit of edits) {
    const sources = settings.agents[edit.agentFolder]?.sources.mcpServers;
    if (!sources) continue;
    const index = sources.findIndex((source) => source.id === edit.serverId);
    if (edit.preserveAbsent) {
      if (index >= 0) sources.splice(index, 1);
      continue;
    }
    if (!edit.original) continue;
    let source = index >= 0 ? sources[index]! : undefined;
    if (!source) {
      source = structuredClone(edit.original);
      sources.push(source);
    }
    if (edit.preserveStatus) {
      if (edit.original.status === undefined) delete source.status;
      else source.status = edit.original.status;
    }
    if (edit.preserveTools) {
      if (edit.original.tools === undefined) delete source.tools;
      else source.tools = [...edit.original.tools];
    }
    sources.sort((left, right) => left.id.localeCompare(right.id));
  }
}

function canonicalStrings(values: readonly string[]): string {
  return JSON.stringify([...new Set(values)].sort());
}
