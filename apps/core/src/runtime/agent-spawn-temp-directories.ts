import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export function createRunnerTempDirectories(input: {
  sandboxProviderId: string;
  toolTempDirLeaf?: string;
}): { runnerTempDir?: string; providerToolTempDir?: string } {
  if (input.sandboxProviderId !== 'sandbox_runtime') return {};
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const runnerTempDir = path.join('/tmp', `gantry-srt-${suffix}`);
  fs.mkdirSync(runnerTempDir, { recursive: false, mode: 0o700 });
  if (!input.toolTempDirLeaf) return { runnerTempDir };
  const providerToolTempDir = path.join(runnerTempDir, input.toolTempDirLeaf);
  fs.mkdirSync(providerToolTempDir, { recursive: true, mode: 0o700 });
  return { runnerTempDir, providerToolTempDir };
}
