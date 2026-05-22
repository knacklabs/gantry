import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

type RuntimeLogger = {
  warn(input: unknown, message: string): void;
};

export function createProgressChannelSender(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  groupName: string;
  finalizingGenerations: Set<number>;
  log: RuntimeLogger;
}) {
  return async (
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void> => {
    if (
      options?.done !== true &&
      options?.generation !== undefined &&
      input.finalizingGenerations.has(options.generation)
    ) {
      return;
    }
    try {
      if (options) {
        await input.channelRuntime.sendProgressUpdate(
          input.chatJid,
          text,
          options,
        );
      } else {
        await input.channelRuntime.sendProgressUpdate(input.chatJid, text);
      }
    } catch (err) {
      input.log.warn(
        {
          err,
          chatJid: input.chatJid,
          group: input.groupName,
          progressText: text,
          done: options?.done ?? false,
          replaceOnly: options?.replaceOnly ?? false,
          generation: options?.generation,
          threadId: options?.threadId,
        },
        'Progress lifecycle runtime send failed',
      );
      throw err;
    }
  };
}
