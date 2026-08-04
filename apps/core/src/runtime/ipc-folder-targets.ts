import type { ConversationRoute } from '../domain/types.js';

export function buildIpcFolderTargets(
  groupRegistry: Record<string, ConversationRoute>,
): {
  folderTargetJid: Map<string, string>;
  folderTargetJids: Map<string, Set<string>>;
} {
  const folderTargetJid = new Map<string, string>();
  const folderTargetJids = new Map<string, Set<string>>();
  for (const [jid, group] of Object.entries(groupRegistry)) {
    if (!folderTargetJid.has(group.folder))
      folderTargetJid.set(group.folder, jid);
    const targets = folderTargetJids.get(group.folder) ?? new Set<string>();
    targets.add(jid);
    folderTargetJids.set(group.folder, targets);
  }
  return { folderTargetJid, folderTargetJids };
}
