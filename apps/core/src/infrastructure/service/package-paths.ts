import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function cliDirFromImportMeta(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function getDistRoot(importMetaUrl: string): string {
  const cliDir = cliDirFromImportMeta(importMetaUrl);
  if (
    path.basename(cliDir) === 'cli' &&
    path.basename(path.dirname(cliDir)) === 'src' &&
    path.basename(path.dirname(path.dirname(cliDir))) === 'core'
  ) {
    return path.resolve(cliDir, '../../../..', 'dist');
  }
  return path.resolve(cliDir, '..');
}

export function getPackageRoot(importMetaUrl: string): string {
  return path.resolve(getDistRoot(importMetaUrl), '..');
}

export function getRuntimeEntryPath(importMetaUrl: string): string {
  return path.resolve(getDistRoot(importMetaUrl), 'index.js');
}

export function assertRuntimeEntryExists(importMetaUrl: string): void {
  const runtimeEntry = getRuntimeEntryPath(importMetaUrl);
  if (!fs.existsSync(runtimeEntry)) {
    throw new Error(
      `Runtime entry is missing at ${runtimeEntry}. Reinstall Gantry from npm.`,
    );
  }
}
