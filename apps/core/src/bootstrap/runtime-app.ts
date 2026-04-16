import { OneCLI } from '@onecli-sh/sdk';

import { ASSISTANT_NAME, ONECLI_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { Channel, RegisteredGroup, ThinkingOverride } from '../core/types.js';
import { findChannel } from '../messaging/router.js';
import { createGroupProcessor } from '../runtime/group-processing.js';
import { listAvailableGroups } from '../runtime/group-registry.js';
import { GroupQueue } from '../runtime/group-queue.js';
import {
  registerGroup as registerGroupEntry,
  setGroupModelOverride as setGroupModelOverrideEntry,
  setGroupThinkingOverride as setGroupThinkingOverrideEntry,
} from '../runtime/group-registry.js';
import {
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getLastBotMessageTimestamp,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from '../storage/db.js';

type OneCliLike = Pick<OneCLI, 'ensureAgent'>;

export interface RuntimeApp {
  channels: Channel[];
  queue: GroupQueue;
  loadState: () => void;
  saveState: () => void;
  getOrRecoverCursor: (chatJid: string) => string;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  setGroupModelOverride: (chatJid: string, model: string | undefined) => void;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => void;
  getAvailableGroups: () => import('../runtime/agent-spawn.js').AvailableGroup[];
  setRegisteredGroupsForTest: (groups: Record<string, RegisteredGroup>) => void;
  ensureOneCLIAgentsForRegisteredGroups: () => void;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
}

export interface RuntimeAppOptions {
  onecli?: OneCliLike;
  queue?: GroupQueue;
}

export function createRuntimeApp(options: RuntimeAppOptions = {}): RuntimeApp {
  let lastTimestamp = '';
  let sessions: Record<string, string> = {};
  let registeredGroups: Record<string, RegisteredGroup> = {};
  let lastAgentTimestamp: Record<string, string> = {};

  const channels: Channel[] = [];
  const queue = options.queue ?? new GroupQueue();
  const onecli = options.onecli ?? new OneCLI({ url: ONECLI_URL });

  function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
    if (group.isMain) return;
    const identifier = group.folder.toLowerCase().replace(/_/g, '-');
    onecli.ensureAgent({ name: group.name, identifier }).then(
      (res) => {
        logger.info(
          { jid, identifier, created: res.created },
          'OneCLI agent ensured',
        );
      },
      (err) => {
        logger.debug(
          { jid, identifier, err: String(err) },
          'OneCLI agent ensure skipped',
        );
      },
    );
  }

  function loadState(): void {
    lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      lastAgentTimestamp = {};
    }
    sessions = getAllSessions();
    registeredGroups = getAllRegisteredGroups();
    logger.info(
      { groupCount: Object.keys(registeredGroups).length },
      'State loaded',
    );
  }

  function saveState(): void {
    setRouterState('last_timestamp', lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  }

  function getOrRecoverCursor(chatJid: string): string {
    const existing = lastAgentTimestamp[chatJid];
    if (existing) return existing;

    const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
    if (botTs) {
      logger.info(
        { chatJid, recoveredFrom: botTs },
        'Recovered message cursor from last bot reply',
      );
      lastAgentTimestamp[chatJid] = botTs;
      saveState();
      return botTs;
    }
    return '';
  }

  function registerGroup(jid: string, group: RegisteredGroup): void {
    registerGroupEntry(registeredGroups, jid, group, {
      assistantName: ASSISTANT_NAME,
      persist: setRegisteredGroup,
      ensureOneCLIAgent,
    });
  }

  function setGroupModelOverride(
    chatJid: string,
    model: string | undefined,
  ): void {
    setGroupModelOverrideEntry(
      registeredGroups,
      chatJid,
      model,
      setRegisteredGroup,
    );
  }

  function setGroupThinkingOverride(
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ): void {
    setGroupThinkingOverrideEntry(
      registeredGroups,
      chatJid,
      thinking,
      setRegisteredGroup,
    );
  }

  function getAvailableGroups(): import('../runtime/agent-spawn.js').AvailableGroup[] {
    return listAvailableGroups(getAllChats(), registeredGroups);
  }

  function setRegisteredGroupsForTest(
    groups: Record<string, RegisteredGroup>,
  ): void {
    registeredGroups = groups;
  }

  function ensureOneCLIAgentsForRegisteredGroups(): void {
    for (const [jid, group] of Object.entries(registeredGroups)) {
      ensureOneCLIAgent(jid, group);
    }
  }

  const groupProcessor = createGroupProcessor({
    channels,
    getGroup: (chatJid) => registeredGroups[chatJid],
    getSession: (groupFolder) => sessions[groupFolder],
    setSession: (groupFolder, sessionId) => {
      sessions[groupFolder] = sessionId;
      setSession(groupFolder, sessionId);
    },
    clearSession: (groupFolder) => {
      delete sessions[groupFolder];
      deleteSession(groupFolder);
    },
    getCursor: getOrRecoverCursor,
    setCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
    queue: {
      closeStdin: (chatJid) => queue.closeStdin(chatJid),
      notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
      stopGroup: (chatJid) => queue.stopGroup(chatJid),
      registerProcess: (
        groupJid,
        proc,
        containerName,
        groupFolder,
        stopAliasJids,
      ) =>
        queue.registerProcess(
          groupJid,
          proc,
          containerName,
          groupFolder,
          stopAliasJids,
        ),
    },
  });

  return {
    channels,
    queue,
    loadState,
    saveState,
    getOrRecoverCursor,
    registerGroup,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    setRegisteredGroupsForTest,
    ensureOneCLIAgentsForRegisteredGroups,
    processGroupMessages: (chatJid) =>
      groupProcessor.processGroupMessages(chatJid),
    getRegisteredGroups: () => registeredGroups,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    setAgentCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
  };
}

let defaultRuntimeApp: RuntimeApp | null = null;

export function getDefaultRuntimeApp(): RuntimeApp {
  if (!defaultRuntimeApp) {
    defaultRuntimeApp = createRuntimeApp();
  }
  return defaultRuntimeApp;
}

export function getAvailableGroups(): import('../runtime/agent-spawn.js').AvailableGroup[] {
  return getDefaultRuntimeApp().getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  getDefaultRuntimeApp().setRegisteredGroupsForTest(groups);
}

export function findAppChannel(
  app: RuntimeApp,
  chatJid: string,
): Channel | undefined {
  return findChannel(app.channels, chatJid);
}
