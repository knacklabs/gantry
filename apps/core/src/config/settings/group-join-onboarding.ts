import { randomUUID } from 'node:crypto';

import type {
  GroupJoinOnboardingCoordinator,
  GroupJoinOnboardingRecord,
  GroupJoinOnboardingRepository,
} from '../../domain/ports/group-join-onboarding.js';
import { nowIso } from '../../shared/time/datetime.js';
import { applyConversationInstallToSettings } from './conversation-install-settings.js';
import {
  loadDesiredRuntimeSettingsForWrite,
  writeDesiredRuntimeSettings,
} from './desired-settings-writer.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
import {
  SettingsRevisionConflictError,
  SettingsStaleMutationError,
} from './settings-import-service.js';

interface GroupJoinCoordinatorDeps {
  runtimeHome: string;
  repository: () => GroupJoinOnboardingRepository;
  loadSettings: () => Promise<RuntimeSettings>;
  writeSettings: typeof writeDesiredRuntimeSettings;
  reloadRuntimeState: () => Promise<void>;
  now: () => string;
  newId: () => string;
}

export function createGroupJoinOnboardingCoordinator(
  deps: Partial<GroupJoinCoordinatorDeps> &
    Pick<
      GroupJoinCoordinatorDeps,
      'runtimeHome' | 'repository' | 'reloadRuntimeState'
    >,
): GroupJoinOnboardingCoordinator {
  const runtimeHome = deps.runtimeHome;
  const resolved: GroupJoinCoordinatorDeps = {
    runtimeHome,
    repository: deps.repository,
    loadSettings:
      deps.loadSettings ??
      (() => loadDesiredRuntimeSettingsForWrite({ runtimeHome })),
    writeSettings: deps.writeSettings ?? writeDesiredRuntimeSettings,
    reloadRuntimeState: deps.reloadRuntimeState,
    now: deps.now ?? nowIso,
    newId: deps.newId ?? randomUUID,
  };

  return {
    beginBootstrap: async (input) => {
      const settings = await resolved.loadSettings();
      const installerExternalId = input.installerExternalId?.trim() ?? '';
      return resolved.repository().recordBootstrap({
        id: resolved.newId(),
        providerAccountId: input.providerAccountId,
        chatJid: input.chatJid,
        adder: installerExternalId,
        approver: installerExternalId,
        promptConversationJid: input.chatJid,
        promptAgentFolder:
          settings.providerAccounts[input.providerAccountId]?.agentId ?? '',
        now: resolved.now(),
      });
    },
    seedInstaller: async ({
      id,
      provider,
      externalId,
      title,
      installerExternalId,
    }) => {
      const repository = resolved.repository();
      const record = await repository.markRegistered({
        id,
        now: resolved.now(),
      });
      if (!record) return null;

      let settingsCommitted = false;
      try {
        await seedInstaller(resolved, {
          record,
          externalId,
          title,
          installerExternalId,
        });
        settingsCommitted = true;
        try {
          await resolved.reloadRuntimeState();
        } catch {
          // Managed settings writes already materialize the conversation.
        }
        try {
          await repository.ensureInstallerParticipant({
            conversationId: `conversation:${record.providerAccountId}:${record.chatJid}`,
            provider,
            providerAccountId: record.providerAccountId,
            installerExternalId,
            now: resolved.now(),
          });
        } catch {
          // Best effort after the settings commit: the settings are the
          // authority, and participants self-heal on the installer's first
          // message (ensureParticipant on ingest), after which the next
          // reconcile applies the seeded approver. Throwing here would leave
          // a terminal registered-but-unapproved state instead.
        }
      } catch (err) {
        if (!settingsCommitted) {
          await repository.revertRegistered({ id, now: resolved.now() });
        }
        throw err;
      }
      try {
        await resolved.reloadRuntimeState();
      } catch {
        // The settings watcher reconciles the committed desired state later.
      }
      return record;
    },
    recordPrompt: (input) =>
      resolved.repository().recordPrompt({
        id: resolved.newId(),
        ...input,
        now: resolved.now(),
      }),
    getById: (id) => resolved.repository().getById(id),
    dismiss: (id) =>
      resolved.repository().markDismissed({ id, now: resolved.now() }),
    markLeft: (input) =>
      resolved.repository().markLeft({ ...input, now: resolved.now() }),
    register: async ({ id, externalId, title, approvedBy }) => {
      const repository = resolved.repository();
      const record = await repository.markRegistered({
        id,
        now: resolved.now(),
      });
      if (!record) return null;

      // ponytail: v1 accepts the crash window between this durable claim and
      // the settings write (row 'registered', no installation). It is
      // RECOVERABLE, not dead state: recordPrompt resets any stale row on the
      // next approver re-add, which re-prompts and re-registers. Upgrade path
      // if it ever matters: a 'registering' intent state + startup sweep.
      try {
        await seedInstaller(resolved, {
          record,
          externalId,
          title,
          installerExternalId: record.approver,
          approvedBy,
        });
      } catch (err) {
        // Revert only when the settings write failed - the claim must not
        // outlive a registration that never committed.
        await repository.revertRegistered({ id, now: resolved.now() });
        throw err;
      }
      // The registration is durably committed; a reload failure must not
      // revert it. The settings watcher reconciles on its next cycle.
      try {
        await resolved.reloadRuntimeState();
      } catch {
        // best-effort - the committed registration stands
      }
      return record;
    },
  };
}

async function seedInstaller(
  deps: GroupJoinCoordinatorDeps,
  input: {
    record: GroupJoinOnboardingRecord;
    externalId: string;
    title: string;
    installerExternalId: string;
    approvedBy?: string;
  },
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const settings = await deps.loadSettings();
    const previousSettings = structuredClone(settings);
    const account = settings.providerAccounts[input.record.providerAccountId];
    if (!account) {
      throw new Error(
        `Provider Account not found: ${input.record.providerAccountId}`,
      );
    }
    applyConversationInstallToSettings({
      settings,
      conversation: {
        id: `conversation:${input.record.providerAccountId}:${input.record.chatJid}` as never,
        externalRef: { kind: 'conversation', value: input.externalId },
        kind: 'channel',
        title: input.title,
      },
      providerAccountId: input.record.providerAccountId,
      agentFolder: account.agentId,
      controlApprovers: [input.installerExternalId],
      now: deps.now(),
    });
    try {
      await deps.writeSettings({
        runtimeHome: deps.runtimeHome,
        settings,
        previousSettings,
        createdBy: `interaction:group-join:${input.approvedBy ?? input.installerExternalId}`,
      });
      return;
    } catch (err) {
      if (
        attempt === 0 &&
        (err instanceof SettingsStaleMutationError ||
          err instanceof SettingsRevisionConflictError)
      ) {
        continue;
      }
      throw err;
    }
  }
}
