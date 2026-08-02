export function createGroupSnapshotSync(app, deps) {
    let syncInFlight;
    let syncDirty = false;
    const runSync = async () => {
        do {
            syncDirty = false;
            const [conversationRoutes, availableGroups] = [
                app.getConversationRoutes(),
                await app.getAvailableGroups(),
            ];
            const registeredJids = new Set(Object.keys(conversationRoutes));
            await Promise.all(Object.values(conversationRoutes).map((group) => deps.writeGroupsSnapshot(group.folder, availableGroups, registeredJids)));
        } while (syncDirty);
    };
    return () => {
        if (syncInFlight) {
            syncDirty = true;
            return;
        }
        syncInFlight = runSync()
            .catch((err) => deps.logger.warn({ err }, 'Failed to write group snapshots'))
            .finally(() => {
            syncInFlight = undefined;
        });
    };
}
