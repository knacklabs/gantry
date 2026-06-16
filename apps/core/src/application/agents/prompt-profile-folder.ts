const AGENT_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_AGENT_FOLDERS = new Set(['global', 'shared']);

export function isValidPromptAgentFolder(agentFolder: string): boolean {
  if (!agentFolder) return false;
  if (agentFolder !== agentFolder.trim()) return false;
  if (!AGENT_FOLDER_PATTERN.test(agentFolder)) return false;
  if (agentFolder.includes('/') || agentFolder.includes('\\')) return false;
  if (agentFolder.includes('..')) return false;
  if (RESERVED_AGENT_FOLDERS.has(agentFolder.toLowerCase())) return false;
  return true;
}
