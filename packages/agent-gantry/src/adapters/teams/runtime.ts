import type {
  GantryAgentTaskInput,
  GantryAgentTaskResult,
  GantryDispatchResult,
  GantryEmbeddedTeamsCardRequest,
  GantryEmbeddedTeamsDmRequest,
  GantryRuntimeConfig,
  GantryRuntimeMessageRecord,
  GantrySignatureInput,
  GantrySignatureVerificationInput,
  GantryStructuredTaskInput,
  GantryStructuredTaskResult,
  GantryTeamsHttpActivityInput,
  GantryTeamsIncomingActivity,
  GantryTeamsIncomingActivityInput,
  GantryTeamsThreadReplyRequest,
  GantryTeamsTransport,
  GantryTeamsConversationReferenceStatus,
} from './types.js';
import {
  signExternalEventRequest,
  verifyExternalEventSignature,
} from './signing.js';
import { parseTeamsIncomingActivity } from './bot-framework.js';

export class GantryRuntime {
  constructor(private readonly config: GantryRuntimeConfig = {}) {}

  readonly teams = {
    sendCard: async (
      input: GantryEmbeddedTeamsCardRequest,
    ): Promise<GantryDispatchResult> => {
      const transport = this.requireTeamsTransport('send Teams cards');
      return await transport.sendCard(input);
    },
    sendDm: async (
      input: GantryEmbeddedTeamsDmRequest,
    ): Promise<GantryDispatchResult> => {
      const transport = this.requireTeamsTransport('send Teams DMs');
      return await transport.sendDm(input);
    },
    sendThreadReply: async (
      input: GantryTeamsThreadReplyRequest,
    ): Promise<GantryDispatchResult> => {
      const transport = this.requireTeamsTransport('send Teams thread replies');
      return await transport.sendThreadReply(input);
    },
    handleIncomingActivity: async (
      input: GantryTeamsIncomingActivityInput,
    ): Promise<GantryTeamsIncomingActivity> => {
      const parsed = this.config.teams?.handleIncomingActivity
        ? await this.config.teams.handleIncomingActivity(input)
        : parseTeamsIncomingActivity(input.activity);
      await this.conversations.recordMessage({
        provider: 'teams',
        conversationId: parsed.conversationId,
        messageId: parsed.messageId,
        senderId: parsed.teamsUserId ?? null,
        text: parsed.text ?? null,
        payload: parsed.raw,
        occurredAt: new Date().toISOString(),
      });
      return parsed;
    },
    handleHttpActivity: async (
      input: GantryTeamsHttpActivityInput,
    ): Promise<void> => {
      const transport = this.requireTeamsTransport(
        'handle Teams HTTP activities',
      );
      if (!transport.handleHttpActivity) {
        throw new Error(
          'Gantry Teams transport does not support HTTP activity handling.',
        );
      }
      await transport.handleHttpActivity({
        ...input,
        onActivity: async (activity) => {
          await this.conversations.recordMessage({
            provider: 'teams',
            conversationId: activity.conversationId,
            messageId: activity.messageId,
            senderId: activity.teamsUserId ?? null,
            text: activity.text ?? null,
            payload: activity.raw,
            occurredAt: new Date().toISOString(),
          });
          await input.onActivity(activity);
        },
      });
    },
    getConversationReferenceStatus: async (
      conversationId: string,
    ): Promise<GantryTeamsConversationReferenceStatus> => {
      const normalized = conversationId.trim();
      const stored =
        await this.config.storage?.getTeamsConversationReference?.(normalized);
      return stored ?? { exists: false, conversationId: normalized };
    },
  };

  readonly tasks = {
    runStructuredTask: async (
      input: GantryStructuredTaskInput,
    ): Promise<GantryStructuredTaskResult> => {
      if (!this.config.tasks) {
        throw new Error('Gantry structured task runner is not configured.');
      }
      return await this.config.tasks.runStructuredTask(input);
    },
    runAgentTask: async (
      input: GantryAgentTaskInput,
    ): Promise<GantryAgentTaskResult> => {
      if (!this.config.tasks?.runAgentTask) {
        throw new Error('Gantry agent task runner is not configured.');
      }
      return await this.config.tasks.runAgentTask(input);
    },
    delegateAgentTask: async (
      input: import('../../shared/types.js').GantryDelegatedAgentTaskInput,
    ): Promise<
      import('../../shared/types.js').GantryDelegatedAgentTaskHandle
    > => {
      if (!this.config.tasks?.delegateAgentTask) {
        throw new Error(
          'Gantry delegated agent task runner is not configured.',
        );
      }
      return await this.config.tasks.delegateAgentTask(input);
    },
    getDelegatedAgentTask: async (
      input: import('../../shared/types.js').GantryDelegatedAgentTaskLookup,
    ): Promise<
      import('../../shared/types.js').GantryDelegatedAgentTaskResult
    > => {
      if (!this.config.tasks?.getDelegatedAgentTask) {
        throw new Error(
          'Gantry delegated agent task lookup is not configured.',
        );
      }
      return await this.config.tasks.getDelegatedAgentTask(input);
    },
  };

  readonly signing = {
    verifyTeamsRequest: (
      input: Omit<GantrySignatureVerificationInput, 'secret'> & {
        readonly secret?: string;
      },
    ): boolean => {
      const secret =
        input.secret ?? this.config.signing?.teamsRequestSecret ?? '';
      if (!secret) {
        throw new Error(
          'Gantry Teams request signing secret is not configured.',
        );
      }
      return verifyExternalEventSignature({ ...input, secret });
    },
    signInternalEvent: (
      input: Omit<GantrySignatureInput, 'secret'> & {
        readonly secret?: string;
      },
    ): string => {
      const secret =
        input.secret ?? this.config.signing?.internalEventSecret ?? '';
      if (!secret) {
        throw new Error(
          'Gantry internal event signing secret is not configured.',
        );
      }
      return signExternalEventRequest({ ...input, secret });
    },
  };

  readonly conversations = {
    recordMessage: async (input: GantryRuntimeMessageRecord): Promise<void> => {
      await this.config.storage?.recordMessage?.(input);
    },
  };

  private requireTeamsTransport(action: string): GantryTeamsTransport {
    if (!this.config.teams) {
      throw new Error(`Gantry Teams transport is required to ${action}.`);
    }
    return this.config.teams;
  }
}

export function createGantryRuntime(
  config: GantryRuntimeConfig = {},
): GantryRuntime {
  return new GantryRuntime(config);
}
