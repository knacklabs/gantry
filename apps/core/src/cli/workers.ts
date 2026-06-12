import * as p from '@clack/prompts';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { nowMs } from '../shared/time/datetime.js';

function usage(): string {
  return ['Usage:', '  gantry workers list'].join('\n');
}

function ageLabel(iso: string): string {
  const ms = nowMs() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export async function runWorkersCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand !== 'list') {
    console.log(usage());
    return 1;
  }

  await initializeRuntimeStorage();
  try {
    const workers =
      await getRuntimeStorage().repositories.workerCoordination.listWorkers();
    if (workers.length === 0) {
      p.note('No worker instances registered.', 'Workers');
      return 0;
    }
    const lines = workers.map(
      (worker) =>
        `${worker.id}  role=${worker.processRole}  status=${worker.status}` +
        `  heartbeat=${ageLabel(worker.heartbeatAt)} ago` +
        `  capabilities=${worker.capabilities.length}`,
    );
    p.note(lines.join('\n'), 'Workers');
    return 0;
  } finally {
    await closeRuntimeStorage();
  }
}
