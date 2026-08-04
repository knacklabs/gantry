export function buildIpcFolderTargets(groupRegistry) {
    const folderTargetJid = new Map();
    const folderTargetJids = new Map();
    for (const [jid, group] of Object.entries(groupRegistry)) {
        if (!folderTargetJid.has(group.folder))
            folderTargetJid.set(group.folder, jid);
        const targets = folderTargetJids.get(group.folder) ?? new Set();
        targets.add(jid);
        folderTargetJids.set(group.folder, targets);
    }
    return { folderTargetJid, folderTargetJids };
}
