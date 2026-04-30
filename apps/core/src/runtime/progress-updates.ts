import type { ProgressUpdateOptions } from '../domain/types.js';

export function buildDoneProgressOptions(
  threadId?: string,
  replaceOnly?: boolean,
): ProgressUpdateOptions {
  return {
    ...(threadId ? { threadId } : {}),
    done: true,
    ...(replaceOnly ? { replaceOnly: true } : {}),
  };
}

export function buildReplaceOnlyProgressOptions(
  threadId?: string,
): ProgressUpdateOptions {
  return { ...(threadId ? { threadId } : {}), replaceOnly: true };
}

export async function sendFinalProgressUpdate(args: {
  enabled: boolean;
  failed: boolean;
  elapsed: string;
  options: ProgressUpdateOptions;
  send: (text: string, options?: ProgressUpdateOptions) => Promise<void>;
  onError?: (err: unknown) => void;
}): Promise<void> {
  if (!args.enabled) return;
  const status = args.failed
    ? `Failed after ${args.elapsed}.`
    : `Done in ${args.elapsed}.`;
  await args.send(status, args.options).catch((err) => args.onError?.(err));
}
