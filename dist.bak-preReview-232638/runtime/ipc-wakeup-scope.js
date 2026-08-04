export class IpcWakeupScopeTracker {
    nextProcessScope = 'all';
    processAgainScope;
    pendingWakeHints = new Map();
    scheduleFullScan() {
        this.nextProcessScope = 'all';
    }
    recordWakeup(hint) {
        if (hint) {
            this.addWakeHint(hint);
            this.nextProcessScope = 'hinted';
            return;
        }
        this.nextProcessScope = 'all';
        this.processAgainScope = 'all';
    }
    recordWakeupDuringPass(hint) {
        if (hint)
            this.addWakeHint(hint);
        this.processAgainScope =
            !hint || this.processAgainScope === 'all' ? 'all' : 'hinted';
    }
    startPass() {
        const scope = this.nextProcessScope;
        this.nextProcessScope = 'all';
        const wakeHints = scope === 'hinted'
            ? new Map(this.pendingWakeHints)
            : new Map();
        this.pendingWakeHints.clear();
        return {
            scope,
            shouldProcessRequestLane: (sourceAgentFolder, lane) => scope === 'all' || Boolean(wakeHints.get(sourceAgentFolder)?.has(lane)),
        };
    }
    scheduleFollowupPass() {
        this.nextProcessScope = this.processAgainScope ?? 'all';
        this.processAgainScope = undefined;
    }
    clearFollowupPass() {
        this.processAgainScope = undefined;
    }
    addWakeHint(hint) {
        const lanes = this.pendingWakeHints.get(hint.workspaceFolder) ?? new Set();
        lanes.add(hint.lane);
        this.pendingWakeHints.set(hint.workspaceFolder, lanes);
    }
}
