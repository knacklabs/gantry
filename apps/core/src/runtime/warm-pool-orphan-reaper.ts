import { execFileSync } from 'node:child_process';

import type { WarmPoolOrphanReaper } from './warm-pool-manager.js';

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export interface ProcessWarmPoolOrphanReaperOptions {
  listProcesses?: () => string;
  kill?: KillFn;
  currentPid?: () => number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultListProcesses(): string {
  return execFileSync('ps', ['-axo', 'pid=,command='], {
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseWarmPoolOrphanPids(input: {
  processTable: string;
  marker: string;
  currentPid: number;
}): number[] {
  const pids: number[] = [];
  for (const line of input.processTable.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (!Number.isInteger(pid) || pid <= 0 || pid === input.currentPid) {
      continue;
    }
    if (!command.includes(input.marker)) continue;
    pids.push(pid);
  }
  return pids;
}

function isProcessAlive(kill: KillFn, pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalWarmWorker(kill: KillFn, pid: number, signal: NodeJS.Signals) {
  try {
    kill(-pid, signal);
    return true;
  } catch {
    try {
      kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export class ProcessWarmPoolOrphanReaper implements WarmPoolOrphanReaper {
  private readonly listProcesses: () => string;
  private readonly kill: KillFn;
  private readonly currentPid: () => number;
  private readonly settleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ProcessWarmPoolOrphanReaperOptions = {}) {
    this.listProcesses = options.listProcesses ?? defaultListProcesses;
    this.kill = options.kill ?? process.kill;
    this.currentPid = options.currentPid ?? (() => process.pid);
    this.settleMs = options.settleMs ?? 250;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async reap(marker: string): Promise<number> {
    const pids = parseWarmPoolOrphanPids({
      processTable: this.listProcesses(),
      marker,
      currentPid: this.currentPid(),
    });
    let signaled = 0;
    for (const pid of pids) {
      if (signalWarmWorker(this.kill, pid, 'SIGTERM')) signaled += 1;
    }
    if (signaled === 0) return 0;
    await this.sleep(this.settleMs);
    for (const pid of pids) {
      if (isProcessAlive(this.kill, pid)) {
        signalWarmWorker(this.kill, pid, 'SIGKILL');
      }
    }
    return signaled;
  }
}
