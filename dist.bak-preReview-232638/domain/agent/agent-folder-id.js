export function agentIdForFolder(folder) {
    return (folder.startsWith('agent:') ? folder : `agent:${folder}`);
}
export function folderForAgentId(agentId) {
    const raw = String(agentId);
    return raw.startsWith('agent:') ? raw.slice('agent:'.length) : null;
}
