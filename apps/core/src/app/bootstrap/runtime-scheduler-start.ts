import type { RuntimeApp } from './runtime-app.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import type { ProcessRole } from './roles/process-role.js';
import type { SchedulerDependencies } from '../../jobs/scheduler.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import type { MessageSendOptions } from '../../domain/types.js';
import {
  closeBrowser,
  getBrowserStatus,
} from '../../runtime/browser-capability.js';
import { resolveConversationRoute } from './runtime-app-routes.js';
import { createSchedulerLifecycleNotificationUpdater } from './scheduler-lifecycle-notification.js';

type RuntimeSchedulerResolvedDeps = Pick<
  SchedulerDependencies,
  | 'opsRepository'
  | 'collectSessionMemory'
  | 'getCredentialBroker'
  | 'getSkillRepository'
  | 'getMcpServerRepository'
  | 'getCapabilitySecretRepository'
  | 'getMcpDnsValidationCache'
  | 'getSkillArtifactStore'
  | 'getToolRepository'
  | 'getAsyncTaskRepository'
  | 'executionAdapter'
  | 'executionAdapters'
  | 'runnerSandboxProvider'
  | 'closeBrowserToolBackends'
> & {
  startSchedulerLoop: (deps: SchedulerDependencies) => void;
  mcpHostnameLookup?: HostnameLookup;
};

export function createRuntimeSchedulerStarter(input: {
  app: RuntimeApp;
  channelWiring: Pick<
    ChannelWiring,
    | 'sendMessage'
    | 'sendStreamingChunk'
    | 'resetStreaming'
    | 'sendProgressUpdate'
  >;
  onSchedulerChanged: SchedulerDependencies['onSchedulerChanged'];
  processRole?: ProcessRole;
  resolved: RuntimeSchedulerResolvedDeps;
}): () => void {
  const schedulerMessageOptions = (
    jid: string,
    options?: MessageSendOptions,
  ): MessageSendOptions | undefined => {
    const providerAccountId =
      options?.providerAccountId ??
      resolveConversationRoute(
        input.app.getConversationRoutes(),
        jid,
        options?.threadId,
      )?.providerAccountId;
    return providerAccountId ? { ...options, providerAccountId } : options;
  };
  return () =>
    input.resolved.startSchedulerLoop({
      processRole: input.processRole,
      conversationRoutes: () => input.app.getConversationRoutes(),
      queue: input.app.queue,
      onProcess: (groupJid, proc, runHandle, workspaceFolder, stopAliasJids) =>
        input.app.queue.registerProcess(
          groupJid,
          proc,
          runHandle,
          workspaceFolder,
          stopAliasJids,
        ),
      sendMessage: (jid, rawText, options) => {
        const messageOptions = schedulerMessageOptions(jid, options);
        return input.channelWiring.sendMessage(jid, rawText, {
          durability: 'required',
          throwOnMissing: true,
          ...(messageOptions ? { messageOptions } : {}),
        });
      },
      ...createSchedulerLifecycleNotificationUpdater({
        channelWiring: input.channelWiring,
      }),
      sendStreamingChunk: input.channelWiring.sendStreamingChunk,
      resetStreaming: input.channelWiring.resetStreaming,
      onSchedulerChanged: input.onSchedulerChanged,
      runAgent: input.app.runAgent,
      opsRepository: input.resolved.opsRepository,
      collectSessionMemory: input.resolved.collectSessionMemory,
      getCredentialBroker:
        input.resolved.getCredentialBroker ??
        (typeof input.app.getCredentialBroker === 'function'
          ? () => input.app.getCredentialBroker()
          : undefined),
      getSkillRepository: input.resolved.getSkillRepository,
      getMcpServerRepository: input.resolved.getMcpServerRepository,
      getCapabilitySecretRepository:
        input.resolved.getCapabilitySecretRepository,
      getMcpHostnameLookup: () => input.resolved.mcpHostnameLookup,
      getMcpDnsValidationCache: input.resolved.getMcpDnsValidationCache,
      getSkillArtifactStore: input.resolved.getSkillArtifactStore,
      getToolRepository: input.resolved.getToolRepository,
      getAsyncTaskRepository: input.resolved.getAsyncTaskRepository,
      getBrowserStatus,
      executionAdapter:
        input.resolved.executionAdapter ?? input.app.executionAdapter,
      executionAdapters:
        input.resolved.executionAdapters ?? input.app.executionAdapters,
      runnerSandboxProvider:
        input.resolved.runnerSandboxProvider ?? input.app.runnerSandboxProvider,
      closeBrowserSession: closeBrowser,
      closeBrowserToolBackends: input.resolved.closeBrowserToolBackends,
    });
}
