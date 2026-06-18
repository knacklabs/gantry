import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import type { ConversationRoute } from '../domain/types.js';
import { providerFromGroupJid, getProviderIds } from './provider-utils.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import {
  capabilityToToolRule,
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  defaultTriggerForAgentName,
  displayAgentName,
  defaultAgentNameFromSettings,
  normalizeDefaultAgentName,
} from './main-agent.js';
import { RuntimeGroupDb } from './runtime-group-db.js';
import { runAccess } from './group-access.js';
import { runHarness } from './group-harness.js';
import { runList } from './group-list.js';
import { runProfile } from './agent-profile.js';
import { verifyTelegramChatAccess } from './telegram.js';
import {
  parseGroupAddArgs,
  parseGroupPolicyArgs,
  parseGroupPolicyDefaultArgs,
  parseGroupPolicyShowArgs,
  parseGroupRemoveArgs,
  parseGroupTriggerArgs,
} from './group-args.js';
import {
  allocateGroupFolder,
  conversationIdsForProvider,
  ensureGroupFiles,
  findConversationIdForAgent,
  formatAgentHarnessLine,
  isInteractiveTerminal,
  listGroupsWithJid,
  loadDatabase,
  normalizeGroupAddSelector,
  pruneAgentSenderPolicyOverride,
  resolveGroupSelector,
  seedTelegramControlApproverForAgent,
  usage,
} from './group-helpers.js';
import { printPolicyChannel } from './group-policy-format.js';
import {
  buildAgentToolAccessView,
  buildRequestableAdminToolAccess,
  formatAgentToolAccess,
  PERMISSION_GATED_NATIVE_TOOLS,
} from '../shared/tool-access-view.js';
import { adminMcpToolNameFromFullName } from '../shared/admin-mcp-tools.js';
import { nowIso } from '../shared/time/datetime.js';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

async function runInfo(
  runtimeHome: string,
  rawSelector?: string,
): Promise<number> {
  if (!rawSelector) {
    p.log.error('Usage: gantry agent info <jid|folder>');
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return 1;
  }

  try {
    let groups: Record<string, ConversationRoute>;
    try {
      groups = await db.getAllConversationRoutes();
    } catch (err) {
      p.log.error(`Could not read groups from database: ${errorMessage(err)}`);
      return 1;
    }

    const resolved = resolveGroupSelector(groups, rawSelector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${rawSelector.trim()}".`);
      return 1;
    }

    const found = resolved.found;
    const settings = loadRuntimeSettings(runtimeHome);
    const defaultAgentName = defaultAgentNameFromSettings(settings);
    const configuredTools = (
      settings.agents[found.group.folder]?.capabilities ?? []
    ).map(({ id }) => capabilityToToolRule(id));
    const enabledAdminTools = selectedAdminToolNames(configuredTools);
    const gatedTools = PERMISSION_GATED_NATIVE_TOOLS.filter(
      (toolName) =>
        !configuredTools.some(
          (configured) =>
            configured === toolName || configured.startsWith(`${toolName}(`),
        ),
    );
    const lines = [
      `JID: ${found.jid}`,
      `Name: ${displayAgentName(found.group, defaultAgentName)}`,
      `Folder: ${found.group.folder}`,
      `Trigger: ${found.group.trigger}`,
      `Requires Trigger: ${found.group.requiresTrigger === false ? 'no' : 'yes'}`,
      formatAgentHarnessLine(settings, found.group.folder),
      `Added At: ${found.group.added_at}`,
      '',
      formatAgentToolAccess(
        buildAgentToolAccessView({
          configuredTools,
          defaultTools: [],
          availableButGatedTools: gatedTools,
          requestableAdminTools:
            buildRequestableAdminToolAccess(enabledAdminTools),
          source: `settings.yaml agents.${found.group.folder}.capabilities`,
        }),
      ),
    ];
    console.log(lines.join('\n'));
    return 0;
  } finally {
    await db?.close();
  }
}

const selectedAdminToolNames = (tools: readonly string[]): Set<string> =>
  new Set(
    tools.map(adminMcpToolNameFromFullName).filter((name) => name !== null),
  );

async function runAdd(runtimeHome: string, args: string[]): Promise<number> {
  const parsed = parseGroupAddArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  const normalized = normalizeGroupAddSelector(parsed.selector || '');
  if (!normalized) {
    p.log.error('Invalid JID/chat-id. Example: tg:-1001234567890');
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return 1;
  }

  try {
    let groups: Record<string, ConversationRoute>;
    try {
      groups = await db.getAllConversationRoutes();
    } catch (err) {
      p.log.error(`Could not read groups from database: ${errorMessage(err)}`);
      return 1;
    }

    if (groups[normalized]) {
      p.log.error(`Agent already exists for ${normalized}.`);
      p.log.info(
        'Next action: run `gantry agent info <jid>` or `gantry agent trigger <jid> <word>`.',
      );
      return 1;
    }

    let displayName = parsed.name?.trim() || '';
    let chatProbeMessage = '';

    if (normalized.startsWith('tg:')) {
      const env = readEnvFile(envFilePath(runtimeHome));
      const token = env.TELEGRAM_BOT_TOKEN?.trim() || '';
      if (!token) {
        p.log.error('TELEGRAM_BOT_TOKEN is missing.');
        p.log.info(
          'Next action: run `gantry config set TELEGRAM_BOT_TOKEN <token>` first.',
        );
        return 1;
      }

      const spinner = p.spinner();
      spinner.start('Verifying Telegram chat access...');
      const access = await verifyTelegramChatAccess({
        token,
        chatJid: normalized,
        sendTestMessage: parsed.sendTestMessage,
      });
      if (!access.ok) {
        spinner.stop('Telegram chat verification failed');
        p.note(
          `${access.message}\nNext action: ${access.nextAction || 'Fix Telegram access and retry.'}`,
          'Telegram Check',
        );
        return 1;
      }
      spinner.stop(access.message);
      displayName = displayName || access.chatTitle || 'Telegram Group';
      chatProbeMessage = access.sentTestMessage
        ? 'A Telegram test message was sent to confirm bot access.'
        : 'Telegram chat access was confirmed (test message skipped).';
    }

    if (!displayName) {
      displayName = normalized;
    }

    const agentFolder = allocateGroupFolder({
      runtimeHome,
      groups,
      preferredFolder: parsed.folder,
      seed: `${displayName}_${normalized}`,
    });

    try {
      await ensureGroupFiles(
        runtimeHome,
        agentFolder,
        displayName,
        db.getFileArtifactStore(),
      );
    } catch (err) {
      p.log.error(`Could not create workspace folder: ${errorMessage(err)}`);
      return 1;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    const previousSettings = structuredClone(settings);
    const requiresTrigger = parsed.requiresTrigger ?? true;
    const defaultTrigger = defaultTriggerForAgentName(
      defaultAgentNameFromSettings(settings),
    );

    const record: ConversationRoute = {
      name: displayName,
      folder: agentFolder,
      trigger: (parsed.trigger || defaultTrigger).trim() || defaultTrigger,
      added_at: nowIso(),
      requiresTrigger,
    };

    try {
      await db.setConversationRoute(normalized, record);
      try {
        ensureConfiguredConversationBinding(settings, {
          agentId: agentFolder,
          agentName: displayName,
          agentFolder,
          jid: normalized,
          displayName,
          trigger: record.trigger,
          requiresTrigger: record.requiresTrigger !== false,
        });
        await writeDesiredRuntimeSettings({
          runtimeHome,
          settings,
          previousSettings,
        });
      } catch {
        // Generic local JIDs are still allowed for file-backed agents; only
        // known provider JIDs participate in conversation desired state.
      }
      try {
        const seededApprover = await seedTelegramControlApproverForAgent({
          runtimeHome,
          db,
          chatJid: normalized,
          agentFolder,
        });
        if (seededApprover) {
          p.log.info(
            `Enabled permission approvals for Telegram sender ${seededApprover} in ${agentFolder}.`,
          );
        }
      } catch (err) {
        p.log.warn(
          `Agent was added, but Telegram permission approver seeding failed: ${errorMessage(err)}`,
        );
      }
    } catch (err) {
      const groupDir = path.join(runtimeHome, 'agents', agentFolder);
      if (fs.existsSync(groupDir)) {
        try {
          fs.rmSync(groupDir, { recursive: true, force: true });
        } catch {
          // Best effort rollback; keep the original database error.
        }
      }
      p.log.error(`Could not save agent in database: ${errorMessage(err)}`);
      return 1;
    }

    p.log.success(
      `Added agent ${displayName} (${normalized}) in folder ${agentFolder}.`,
    );
    if (chatProbeMessage) p.log.info(chatProbeMessage);
    return 0;
  } finally {
    await db?.close();
  }
}

async function runName(runtimeHome: string, args: string[]): Promise<number> {
  const nextName = normalizeDefaultAgentName(args.join(' '));
  if (nextName.length > 80) {
    p.log.error('Default agent name must be 80 characters or fewer.');
    return 1;
  }
  try {
    const settings = loadRuntimeSettings(runtimeHome);
    const previousSettings = structuredClone(settings);
    const previous = defaultAgentNameFromSettings(settings);
    settings.agent.name = nextName;
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
    });
    p.log.success(
      `Default agent name updated from "${previous}" to "${nextName}".`,
    );
    p.log.info(
      'Restart Gantry for all running processes to pick up the new identity.',
    );
    return 0;
  } catch (err) {
    p.log.error(
      `Could not update default agent name: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

async function runRemove(runtimeHome: string, args: string[]): Promise<number> {
  const parsed = parseGroupRemoveArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return 1;
  }

  try {
    let groups: Record<string, ConversationRoute>;
    try {
      groups = await db.getAllConversationRoutes();
    } catch (err) {
      p.log.error(`Could not read groups from database: ${errorMessage(err)}`);
      return 1;
    }

    const selector = parsed.selector || '';
    const resolved = resolveGroupSelector(groups, selector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${selector.trim()}".`);
      return 1;
    }
    const found = resolved.found;

    if (!parsed.assumeYes) {
      if (!isInteractiveTerminal()) {
        p.log.error(
          'Refusing destructive removal in non-interactive mode without --yes.',
        );
        p.log.info(
          'Next action: rerun with `--yes` (and `--delete-folder` if you want to remove files too).',
        );
        return 1;
      }

      const folderPath = path.join(runtimeHome, 'agents', found.group.folder);
      const decision = await p.select({
        message: parsed.deleteFolder
          ? `Remove ${found.group.name} (${found.jid}) and delete folder ${folderPath}?`
          : `Remove ${found.group.name} (${found.jid}) from the database?`,
        options: [
          { label: 'Yes, remove it', value: 'yes' },
          { label: 'No, cancel', value: 'no' },
        ],
      });
      if (p.isCancel(decision) || decision !== 'yes') {
        p.log.warn('Agent removal cancelled. No changes were made.');
        return 0;
      }
    }

    try {
      await db.deleteConversationRoute(found.jid);
      await db.deleteSession(found.group.folder);
    } catch (err) {
      p.log.error(`Could not remove agent from database: ${errorMessage(err)}`);
      return 1;
    }

    const policyPrune = await pruneAgentSenderPolicyOverride(
      runtimeHome,
      found.jid,
      found.group.folder,
    );
    if (policyPrune.error) {
      p.log.warn(
        `Agent removed, but sender policy cleanup failed for folder ${found.group.folder}: ${policyPrune.error}`,
      );
    } else if (policyPrune.pruned) {
      p.log.info(
        `Removed sender policy override for folder ${found.group.folder}.`,
      );
    }

    if (parsed.deleteFolder) {
      const folderPath = path.join(runtimeHome, 'agents', found.group.folder);
      try {
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: false });
        }
      } catch (err) {
        p.log.warn(
          `Agent removed from database, but folder cleanup failed: ${folderPath}. Details: ${errorMessage(err)}`,
        );
        return 1;
      }
    }

    p.log.success(`Removed agent ${found.group.name} (${found.jid}).`);
    if (!parsed.deleteFolder) {
      p.log.info(
        `Agent folder preserved at ${path.join(runtimeHome, 'agents', found.group.folder)}. Use --delete-folder to remove it.`,
      );
    }
    return 0;
  } finally {
    await db?.close();
  }
}

async function runTrigger(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseGroupTriggerArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return 1;
  }

  try {
    let groups: Record<string, ConversationRoute>;
    try {
      groups = await db.getAllConversationRoutes();
    } catch (err) {
      p.log.error(`Could not read groups from database: ${errorMessage(err)}`);
      return 1;
    }

    const selector = parsed.selector || '';
    const resolved = resolveGroupSelector(groups, selector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${selector.trim()}".`);
      return 1;
    }
    const found = resolved.found;

    const nextGroup: ConversationRoute = {
      ...found.group,
      requiresTrigger: parsed.disable ? false : true,
      trigger: parsed.disable
        ? found.group.trigger
        : (parsed.trigger || '').trim() || found.group.trigger,
    };

    if (!parsed.disable && !nextGroup.trigger.trim()) {
      p.log.error('Trigger word cannot be empty.');
      return 1;
    }

    try {
      await db.setConversationRoute(found.jid, nextGroup);
      try {
        const settings = loadRuntimeSettings(runtimeHome);
        const previousSettings = structuredClone(settings);
        ensureConfiguredConversationBinding(settings, {
          agentId: found.group.folder,
          agentName: found.group.name,
          agentFolder: found.group.folder,
          jid: found.jid,
          displayName: found.group.name,
          trigger: nextGroup.trigger,
          requiresTrigger: nextGroup.requiresTrigger !== false,
        });
        await writeDesiredRuntimeSettings({
          runtimeHome,
          settings,
          previousSettings,
        });
      } catch {
        // Generic local JIDs are still allowed for file-backed agents; only
        // known provider JIDs participate in conversation desired state.
      }
    } catch (err) {
      p.log.error(`Could not update trigger settings: ${errorMessage(err)}`);
      return 1;
    }

    if (parsed.disable) {
      p.log.success(
        `Trigger requirement disabled for ${found.group.name} (${found.jid}).`,
      );
      return 0;
    }

    p.log.success(
      `Trigger for ${found.group.name} (${found.jid}) is now "${nextGroup.trigger}".`,
    );
    return 0;
  } finally {
    await db?.close();
  }
}

async function runPolicy(runtimeHome: string, args: string[]): Promise<number> {
  const parsed = parseGroupPolicyArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return 1;
  }

  try {
    const groups = await db.getAllConversationRoutes();
    const selector = parsed.selector || '';
    const resolved = resolveGroupSelector(groups, selector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${selector.trim()}".`);
      return 1;
    }

    const found = resolved.found;
    const channel = providerFromGroupJid(found.jid);
    if (!channel) {
      p.log.error(
        `Agent ${found.group.name} (${found.jid}) does not map to a registered provider.`,
      );
      return 1;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    const previousSettings = structuredClone(settings);
    const ensured = ensureConfiguredConversationBinding(settings, {
      agentId: found.group.folder,
      agentName: found.group.name,
      agentFolder: found.group.folder,
      jid: found.jid,
      displayName: found.group.name,
      trigger: found.group.trigger,
      requiresTrigger: found.group.requiresTrigger !== false,
    });
    const conversation =
      settings.conversations[
        findConversationIdForAgent(settings, found.group.folder, channel) ||
          ensured.conversationId
      ];
    if (!conversation) {
      p.log.error(
        `Agent ${found.group.name} (${found.jid}) does not have a configured conversation.`,
      );
      return 1;
    }

    if (parsed.clear) {
      conversation.senderPolicy = { allow: '*', mode: 'trigger' };
      await writeDesiredRuntimeSettings({
        runtimeHome,
        settings,
        previousSettings,
      });
      p.log.success(
        `Cleared sender policy for ${found.group.name} (${found.group.folder}) in ${channel}.`,
      );
      return 0;
    }

    conversation.senderPolicy = {
      allow: parsed.allow!,
      mode: parsed.mode ?? conversation.senderPolicy.mode,
    };
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
    });
    p.log.success(
      `Updated ${channel} sender policy for ${found.group.name} (${found.group.folder}).`,
    );
    return 0;
  } catch (err) {
    p.log.error(`Could not update sender policy: ${errorMessage(err)}`);
    return 1;
  } finally {
    await db?.close();
  }
}

async function runPolicyDefault(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseGroupPolicyDefaultArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  try {
    const settings = loadRuntimeSettings(runtimeHome);
    const previousSettings = structuredClone(settings);
    const channel = parsed.channel;
    const allow = parsed.allow;
    if (!channel || allow === undefined) {
      p.log.error('Missing required policy-default arguments.');
      return 1;
    }
    const conversationIds = conversationIdsForProvider(settings, channel);
    if (conversationIds.length === 0) {
      p.log.error(
        `No configured ${channel} conversations found. Add or connect a conversation before setting its sender policy.`,
      );
      return 1;
    }
    for (const conversationId of conversationIds) {
      const conversation = settings.conversations[conversationId];
      if (!conversation) continue;
      conversation.senderPolicy = {
        allow,
        mode: parsed.mode ?? conversation.senderPolicy.mode,
      };
    }
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
    });
    p.log.success(
      `Updated sender policy for ${conversationIds.length} ${channel} conversation${conversationIds.length === 1 ? '' : 's'}.`,
    );
    return 0;
  } catch (err) {
    p.log.error(`Could not update default sender policy: ${errorMessage(err)}`);
    return 1;
  }
}

async function runPolicyShow(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseGroupPolicyShowArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  try {
    const settings = loadRuntimeSettings(runtimeHome);
    if (parsed.channel) {
      printPolicyChannel(parsed.channel, settings);
      return 0;
    }
    const channels = getProviderIds();
    for (let i = 0; i < channels.length; i += 1) {
      printPolicyChannel(channels[i]!, settings);
      if (i < channels.length - 1) {
        console.log('');
      }
    }
    return 0;
  } catch (err) {
    p.log.error(`Could not read sender policies: ${errorMessage(err)}`);
    return 1;
  }
}

export async function runAgentCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return subcommand ? 0 : 1;
  }
  switch (subcommand) {
    case 'list':
      return runList(runtimeHome);
    case 'info':
      return runInfo(runtimeHome, rest[0]);
    case 'add':
      return runAdd(runtimeHome, rest);
    case 'name':
      return runName(runtimeHome, rest);
    case 'remove':
      return runRemove(runtimeHome, rest);
    case 'trigger':
      return runTrigger(runtimeHome, rest);
    case 'policy':
      return runPolicy(runtimeHome, rest);
    case 'policy-default':
      return runPolicyDefault(runtimeHome, rest);
    case 'policy-show':
      return runPolicyShow(runtimeHome, rest);
    case 'access':
      return runAccess(runtimeHome, rest);
    case 'harness':
      return runHarness(runtimeHome, rest);
    case 'profile':
      return runProfile(runtimeHome, rest);
    default:
      p.log.error(`Unknown agent command: ${subcommand}`);
      console.log(usage());
      return 1;
  }
}
