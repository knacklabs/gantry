import { randomUUID } from 'node:crypto';

import type {
  GroupJoinOnboardingCoordinator,
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
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const settings = await resolved.loadSettings();
          const previousSettings = structuredClone(settings);
          const account = settings.providerAccounts[record.providerAccountId];
          if (!account) {
            throw new Error(
              `Provider Account not found: ${record.providerAccountId}`,
            );
          }
          applyConversationInstallToSettings({
            settings,
            conversation: {
              id: `conversation:${record.providerAccountId}:${record.chatJid}` as never,
              externalRef: {
                kind: 'conversation',
                value: externalId,
              },
              kind: 'channel',
              title,
            },
            providerAccountId: record.providerAccountId,
            agentFolder: account.agentId,
            controlApprovers: [record.approver],
            now: resolved.now(),
          });
          try {
            await resolved.writeSettings({
              runtimeHome: resolved.runtimeHome,
              settings,
              previousSettings,
              createdBy: `interaction:group-join:${approvedBy}`,
            });
            break;
          } catch (err) {
            // The same concurrent-writer race surfaces as either error class
            // depending on where the append loses; retry both once.
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
