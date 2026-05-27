import * as p from '@clack/prompts';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { guardrailPolicySettingsValidator } from '../application/guardrails/policy-registry.js';
import { SettingsDesiredStateService } from '../config/settings/desired-state-service.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';

function usage(): string {
  return [
    'Usage:',
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

  await initializeRuntimeStorage();
  try {
    const storage = getRuntimeStorage();
    const service = new SettingsDesiredStateService({
      ops: storage.ops,
      repositories: storage.repositories,
      guardrailPolicies: guardrailPolicySettingsValidator(),
    });
    const settings = loadRuntimeSettings(runtimeHome);

    if (subcommand === 'export-current') {
      const exported = await service.exportCurrent(settings);
      saveRuntimeSettings(runtimeHome, exported);
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
