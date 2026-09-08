import * as p from '@clack/prompts';

import { offboardAgent } from '../application/agents/offboard-agent.js';
import { PostgresAgentOffboardingRepository } from '../adapters/storage/postgres/repositories/agent-offboarding-repository.postgres.js';
import {
  closeRuntimeStorage,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import { systemPrincipal } from '../domain/identity/principal-ref.js';
import { nowIso } from '../shared/time/datetime.js';
import { parseGroupOffboardArgs } from './group-args.js';

interface SettingsWithAgents {
  agents: Record<string, unknown>;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** CLI adapter for the durable AI-employee offboarding use case. */
export async function runOffboard<TSettings extends SettingsWithAgents>(input: {
  runtimeHome: string;
  args: string[];
  loadSettings: () => Promise<TSettings>;
  removeAgent: (settings: TSettings, folder: string) => unknown;
  settingsToRevisionDocument: (
    settings: TSettings,
  ) => Promise<Record<string, unknown>>;
  currentSettingsReaderVersion: () => Promise<number>;
  saveSettings: (runtimeHome: string, settings: TSettings) => void;
  initializeStorage: (settings: TSettings) => Promise<unknown>;
}): Promise<number> {
  const parsed = parseGroupOffboardArgs(input.args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }
  if (!parsed.assumeYes) {
    p.log.error('Refusing destructive offboarding without --yes.');
    p.log.info('Next action: rerun with `--yes`.');
    return 1;
  }

  try {
    const settings = await input.loadSettings();
    const selector = parsed.selector!.trim();
    const folder = Object.keys(settings.agents).find(
      (candidate) =>
        candidate === selector || agentIdForFolder(candidate) === selector,
    );
    if (!folder) {
      p.log.error(`No AI employee found for "${selector}".`);
      return 1;
    }
    if (folder === 'main_agent') {
      p.log.error('The default AI employee cannot be offboarded.');
      return 1;
    }

    const nextSettings = structuredClone(settings);
    input.removeAgent(nextSettings, folder);
    await input.initializeStorage(settings);
    let result;
    try {
      const storage = getRuntimeStorage();
      const revision =
        await storage.repositories.settingsRevisions.getLatestSettingsRevision(
          'default' as never,
        );
      result = await offboardAgent({
        repository: new PostgresAgentOffboardingRepository(storage.service.db),
        appId: 'default',
        agentId: agentIdForFolder(folder),
        defaultAgentId: agentIdForFolder('main_agent'),
        expectedSettingsRevision: revision?.revision ?? 0,
        settingsDocument: await input.settingsToRevisionDocument(nextSettings),
        createdBy: 'cli:agent-offboard',
        actor: systemPrincipal('cli:agent-offboard'),
        now: nowIso(),
        minReaderVersion: await input.currentSettingsReaderVersion(),
      });
    } finally {
      await closeRuntimeStorage();
    }
    if (result.status === 'already_offboarded') {
      p.log.info('This AI employee is already offboarded.');
      return 0;
    }
    try {
      input.saveSettings(input.runtimeHome, nextSettings);
    } catch (err) {
      p.log.warn(
        `AI employee offboarded, but settings.yaml will be restored from the committed revision: ${errorMessage(err)}.`,
      );
    }
    p.log.success(
      `AI employee ${result.agentName} is offboarded. Provider accounts disabled, conversation installs removed, and scheduled jobs cancelled. Secrets were retained.`,
    );
    return 0;
  } catch (err) {
    p.log.error(`Could not offboard AI employee: ${errorMessage(err)}`);
    return 1;
  }
}
