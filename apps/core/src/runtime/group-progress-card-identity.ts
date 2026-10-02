import type { ProgressUpdateOptions } from '../domain/types.js';

export type ProgressCardTarget = {
  key: string;
  dispatchOptions?: ProgressUpdateOptions;
};

function progressCardKey(input: {
  chatJid: string;
  providerAccountId?: string;
  threadId?: string;
  providerCardIdentity?: string;
}): string {
  return [
    input.chatJid,
    input.providerAccountId ?? '',
    input.threadId ?? '',
    input.providerCardIdentity ?? '',
  ].join('\n');
}

export function resolveProgressCardTarget(input: {
  chatJid: string;
  defaultProviderAccountId?: string;
  defaultThreadId?: string;
  options?: ProgressUpdateOptions;
  resolveProviderCardIdentity: (
    options?: ProgressUpdateOptions,
  ) => string | undefined;
}): ProgressCardTarget {
  const providerAccountId =
    input.options?.providerAccountId ?? input.defaultProviderAccountId;
  const threadId = input.options?.threadId ?? input.defaultThreadId;
  const normalizedOptions =
    input.options || providerAccountId !== undefined || threadId !== undefined
      ? {
          ...input.options,
          ...(providerAccountId !== undefined ? { providerAccountId } : {}),
          ...(threadId !== undefined ? { threadId } : {}),
        }
      : undefined;
  const providerCardIdentity =
    input.resolveProviderCardIdentity(normalizedOptions);
  return {
    key: progressCardKey({
      chatJid: input.chatJid,
      providerAccountId,
      threadId,
      providerCardIdentity,
    }),
    dispatchOptions:
      providerCardIdentity !== undefined
        ? { ...normalizedOptions, progressCardIdentity: providerCardIdentity }
        : normalizedOptions,
  };
}
