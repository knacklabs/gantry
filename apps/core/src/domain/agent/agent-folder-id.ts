import type { AgentId } from './agent.js';

export function agentIdForFolder(folder: string): AgentId {
  return (folder.startsWith('agent:') ? folder : `agent:${folder}`) as AgentId;
}

export function folderForAgentId(agentId: AgentId): string | null {
  const raw = String(agentId);
  return raw.startsWith('agent:') ? raw.slice('agent:'.length) : null;
}
