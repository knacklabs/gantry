import * as p from '@clack/prompts';
import fs from 'node:fs';
import path from 'node:path';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  applyRuntimeSettingsDesiredState,
  getDeploymentMode,
  loadRuntimeSettings,
  loadRuntimeSettingsFromPath,
  SettingsDesiredStateService,
} from '../config/index.js';
import { importFleetSettingsRevision } from '../config/settings/settings-import-service.js';
import type { AppId } from '../domain/app/app.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry settings validate',
    '  gantry settings import --file <path> [--fleet] [--expected-revision <n>] [--note <text>]',
    '  gantry settings export',
    '  gantry settings drift',
    '  gantry settings revisions list',
    '',
    'Workstation import writes settings.yaml (the restart source of truth).',
    'Fleet import (or --fleet) appends a desired-state revision in Postgres.',
  ].join('\n');
}

interface ImportFlags {
  file?: string;
  fleet: boolean;
  expectedRevision?: number;
  note?: string;
}

function parseImportFlags(args: string[]): ImportFlags {
  const flags: ImportFlags = { fleet: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--file') {
      flags.file = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--file=')) {
      flags.file = arg.slice('--file='.length);
    } else if (arg === '--fleet') {
      flags.fleet = true;
    } else if (arg === '--expected-revision') {
      flags.expectedRevision = Number(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--expected-revision=')) {
      flags.expectedRevision = Number(arg.slice('--expected-revision='.length));
    } else if (arg === '--note') {
      flags.note = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--note=')) {
      flags.note = arg.slice('--note='.length);
    }
  }
  return flags;
}

export async function runSettingsCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [subcommand] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return subcommand ? 0 : 1;
  }

  if (subcommand === 'validate') {
    try {
      loadRuntimeSettingsFromPath(path.join(runtimeHome, 'settings.yaml'));
      p.log.success('settings.yaml schema is valid.');
      return 0;
    } catch (err) {
      p.log.error(
        `settings.yaml schema is invalid: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 1;
    }
  }

  await initializeRuntimeStorage();
  try {
    const storage = getRuntimeStorage();
    const service = new SettingsDesiredStateService({
      ops: storage.ops,
      repositories: storage.repositories,
    });
    const settings = loadRuntimeSettings(runtimeHome);

    if (subcommand === 'export') {
      const exported = await service.exportCurrent(settings);
      await applyRuntimeSettingsDesiredState({
        runtimeHome,
        settings: exported,
        ops: storage.ops,
        repositories: storage.repositories,
        appId: 'default' as AppId,
        previousSettings: settings,
      });
      const agentCount = Object.keys(exported.agents).length;
      p.log.success(
        `Exported ${agentCount} agent desired-state record(s) to settings.yaml.`,
      );
      p.log.info(
        'Review settings.yaml before setting desired_state.authoritative=true.',
      );
      return 0;
    }

    if (subcommand === 'import') {
      return runImport(runtimeHome, args.slice(1), storage);
    }

    if (subcommand === 'drift') {
      const drift = await service.drift(settings);
      const lines = [
        `Missing settings agents: ${drift.missingSettingsAgents.join(', ') || 'none'}`,
        `DB-only group JIDs: ${drift.dbOnlyGroupJids.join(', ') || 'none'}`,
        `Invalid references: ${drift.invalidReferences.join('; ') || 'none'}`,
      ];
      p.note(lines.join('\n'), 'Settings Drift');
      return drift.invalidReferences.length > 0 ? 1 : 0;
    }

    if (subcommand === 'revisions') {
      return runRevisions(args.slice(1), storage);
    }

    p.log.error(`Unknown settings command: ${subcommand}`);
    console.log(usage());
    return 1;
  } finally {
    await closeRuntimeStorage();
  }
}

async function runImport(
  runtimeHome: string,
  args: string[],
  storage: ReturnType<typeof getRuntimeStorage>,
): Promise<number> {
  const flags = parseImportFlags(args);
  if (!flags.file) {
    p.log.error('settings import requires --file <path>.');
    return 1;
  }
  if (!fs.existsSync(flags.file)) {
    p.log.error(`settings import file not found: ${flags.file}`);
    return 1;
  }
  let parsed;
  try {
    parsed = loadRuntimeSettingsFromPath(flags.file);
  } catch (err) {
    p.log.error(
      `settings file failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const fleet = flags.fleet || getDeploymentMode() === 'fleet';
  if (!fleet) {
    try {
      await applyRuntimeSettingsDesiredState({
        runtimeHome,
        settings: parsed,
        ops: storage.ops,
        repositories: storage.repositories,
        appId: 'default' as AppId,
        previousSettings: loadRuntimeSettings(runtimeHome),
      });
    } catch (err) {
      p.log.error(
        `settings import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    p.log.success(`Imported ${flags.file} into settings.yaml (workstation).`);
    return 0;
  }

  const outcome = await importFleetSettingsRevision(
    {
      runtimeHome,
      ops: storage.ops,
      repositories: storage.repositories,
      appId: 'default' as AppId,
      settingsRevisions: storage.repositories.settingsRevisions,
      pool: storage.service.pool,
      createdBy: 'cli:settings-import',
    },
    parsed,
    {
      expectedRevision: Number.isInteger(flags.expectedRevision)
        ? flags.expectedRevision
        : null,
      note: flags.note ?? null,
    },
  );
  if (outcome.status === 'invalid') {
    p.log.error('Fleet settings import failed validation:');
    for (const detail of outcome.errors) p.log.error(`  - ${detail}`);
    return 1;
  }
  if (outcome.status === 'conflict') {
    p.log.error(
      `Stale revision: expected ${outcome.expectedRevision}, current is ${outcome.actualRevision}. Re-run against the latest.`,
    );
    return 1;
  }
  p.log.success(`Appended fleet settings revision ${outcome.revision}.`);
  return 0;
}

async function runRevisions(
  args: string[],
  storage: ReturnType<typeof getRuntimeStorage>,
): Promise<number> {
  if (args[0] !== 'list') {
    p.log.error('Usage: gantry settings revisions list');
    return 1;
  }
  const revisions =
    await storage.repositories.settingsRevisions.listRecentSettingsRevisions({
      appId: 'default' as AppId,
      limit: 50,
    });
  if (revisions.length === 0) {
    p.note('No settings revisions recorded.', 'Settings Revisions');
    return 0;
  }
  const lines = revisions.map(
    (revision) =>
      `#${revision.revision}  ${revision.createdAt}  by ${revision.createdBy}` +
      `  min-reader=${revision.minReaderVersion}` +
      (revision.note ? `  note: ${revision.note}` : ''),
  );
  p.note(lines.join('\n'), 'Settings Revisions');
  return 0;
}
