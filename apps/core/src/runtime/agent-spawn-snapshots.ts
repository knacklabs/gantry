import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../platform/group-folder.js';
import {
  AvailableGroup,
  JobRunSnapshotRow,
  JobSnapshotRow,
} from './agent-spawn-types.js';

export function writeJobsSnapshot(
  groupFolder: string,
  isMain: boolean,
  jobs: JobSnapshotRow[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filtered = isMain
    ? jobs
    : jobs.filter((job) => job.group_scope === groupFolder);

  const file = path.join(groupIpcDir, 'current_jobs.json');
  fs.writeFileSync(file, JSON.stringify(filtered, null, 2));
}

export function writeJobRunsSnapshot(
  groupFolder: string,
  isMain: boolean,
  runs: JobRunSnapshotRow[],
  jobs: JobSnapshotRow[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  let allowedJobIds: Set<string> | null = null;
  if (!isMain) {
    allowedJobIds = new Set(
      jobs
        .filter((job) => job.group_scope === groupFolder)
        .map((job) => job.id),
    );
  }

  const filtered =
    isMain || !allowedJobIds
      ? runs
      : runs.filter((run) => allowedJobIds.has(run.job_id));

  const file = path.join(groupIpcDir, 'current_job_runs.json');
  fs.writeFileSync(file, JSON.stringify(filtered, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
