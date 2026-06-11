import * as p from '@clack/prompts';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import type { AppId } from '../domain/app/app.js';
import { nowMs } from '../shared/time/datetime.js';

function usage(): string {
  return ['Usage:', '  gantry bake status'].join('\n');
}

function ageLabel(iso: string): string {
  const ms = nowMs() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export async function runBakeCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand !== 'status') {
    console.log(usage());
    return 1;
  }

  await initializeRuntimeStorage();
  try {
    const rows =
      await getRuntimeStorage().repositories.runtimeDependencies.listRuntimeDependencies(
        { appId: 'default' as AppId },
      );
    if (rows.length === 0) {
      p.note('No toolchain bake manifests recorded.', 'Bake Status');
      return 0;
    }
    const lines = rows.map(
      (row) =>
        `${row.manifestHash.slice(0, 16)}  status=${row.status}` +
        `  age=${ageLabel(row.updatedAt)}` +
        (row.failureReason ? `  failure: ${row.failureReason}` : ''),
    );
    p.note(lines.join('\n'), 'Bake Status');
    return 0;
  } finally {
    await closeRuntimeStorage();
  }
}
