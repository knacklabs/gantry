import type { IpcRequestWakeupHint } from './ipc-request-wakeup-registry.js';
import type { RunnerControlRequestLane } from './runner-control-port.js';

type IpcProcessScope = 'all' | 'hinted';

export interface IpcWakeupProcessPlan {
  scope: IpcProcessScope;
  shouldProcessRequestLane(
    sourceAgentFolder: string,
    lane: RunnerControlRequestLane,
  ): boolean;
}

export class IpcWakeupScopeTracker {
  private nextProcessScope: IpcProcessScope = 'all';
  private processAgainScope: IpcProcessScope | undefined;
  private readonly pendingWakeHints = new Map<
    string,
    Set<RunnerControlRequestLane>
  >();

  scheduleFullScan(): void {
    this.nextProcessScope = 'all';
  }

  recordWakeup(hint?: IpcRequestWakeupHint): void {
    if (hint) {
      this.addWakeHint(hint);
      this.nextProcessScope = 'hinted';
      return;
    }
    this.nextProcessScope = 'all';
    this.processAgainScope = 'all';
  }

  recordWakeupDuringPass(hint?: IpcRequestWakeupHint): void {
    if (hint) this.addWakeHint(hint);
    this.processAgainScope =
      !hint || this.processAgainScope === 'all' ? 'all' : 'hinted';
  }

  startPass(): IpcWakeupProcessPlan {
    const scope = this.nextProcessScope;
    this.nextProcessScope = 'all';
    const wakeHints =
      scope === 'hinted'
        ? new Map(this.pendingWakeHints)
        : new Map<string, Set<RunnerControlRequestLane>>();
    this.pendingWakeHints.clear();
    return {
      scope,
      shouldProcessRequestLane: (sourceAgentFolder, lane) =>
        scope === 'all' || Boolean(wakeHints.get(sourceAgentFolder)?.has(lane)),
    };
  }

  scheduleFollowupPass(): void {
    this.nextProcessScope = this.processAgainScope ?? 'all';
    this.processAgainScope = undefined;
  }

  clearFollowupPass(): void {
    this.processAgainScope = undefined;
  }

  private addWakeHint(hint: IpcRequestWakeupHint): void {
    const lanes = this.pendingWakeHints.get(hint.workspaceFolder) ?? new Set();
    lanes.add(hint.lane);
    this.pendingWakeHints.set(hint.workspaceFolder, lanes);
  }
}
