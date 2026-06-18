import * as p from '@clack/prompts';

import type { ConversationRoute } from '../domain/types.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import {
  defaultAgentNameFromSettings,
  displayAgentName,
} from './main-agent.js';
import { getProviderIds } from './provider-utils.js';
import { RuntimeGroupDb } from './runtime-group-db.js';
import { listGroupsWithJid, loadDatabase } from './group-helpers.js';
import { formatAgentHarnessCell } from './group-engine.js';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// `gantry agent list` — registered agents with their selected harness.
export async function runList(runtimeHome: string): Promise<number> {
  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return 1;
  }

  try {
    let groups: Array<{ jid: string; group: ConversationRoute }>;
    try {
      groups = listGroupsWithJid(await db.getAllConversationRoutes());
    } catch (err) {
      p.log.error(
        `Could not read registered groups from database. The DB may be corrupted. Details: ${errorMessage(err)}`,
      );
      return 1;
    }

    if (groups.length === 0) {
      p.log.warn('No agents are registered in this runtime home.');
      const connectCommands = getProviderIds().map(
        (channel) => `\`gantry provider connect ${channel}\``,
      );
      p.log.info(
        `Next action: run \`gantry agent add <chat-id>\` or ${connectCommands.join(' / ')}.`,
      );
      return 0;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    const defaultAgentName = defaultAgentNameFromSettings(settings);
    const lines = [
      'Registered agents:',
      '',
      'JID | Name | Folder | Trigger | Requires Trigger | Agent Harness',
    ];

    for (const entry of groups) {
      lines.push(
        [
          entry.jid,
          displayAgentName(entry.group, defaultAgentName),
          entry.group.folder,
          entry.group.trigger,
          entry.group.requiresTrigger === false ? 'no' : 'yes',
          formatAgentHarnessCell(settings, entry.group.folder),
        ].join(' | '),
      );
    }

    console.log(lines.join('\n'));
    return 0;
  } finally {
    await db?.close();
  }
}
