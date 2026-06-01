import * as p from '@clack/prompts';
import path from 'node:path';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  applyRuntimeSettingsDesiredState,
  loadRuntimeSettings,
  loadRuntimeSettingsFromPath,
  SettingsDesiredStateService,
} from '../config/index.js';
import type { AppId } from '../domain/app/app.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry settings validate',
    '  gantry settings export-current',
    '  gantry settings drift',
    '',
    'Settings are local desired state in settings.yaml. Export before enabling desired_state.authoritative.',
  ].join('\n');
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

    if (subcommand === 'export-current') {
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

    p.log.error(`Unknown settings command: ${subcommand}`);
    console.log(usage());
    return 1;
  } finally {
    await closeRuntimeStorage();
  }
}
