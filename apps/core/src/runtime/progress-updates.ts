import type { ProgressUpdateOptions } from '../domain/types.js';

export type FinalProgressState = 'completed' | 'failed' | 'delivery_incomplete';

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
  state: FinalProgressState;
  elapsed: string;
  options: ProgressUpdateOptions;
  send: (text: string, options?: ProgressUpdateOptions) => Promise<void>;
  onError?: (err: unknown) => void;
}): Promise<void> {
  if (!args.enabled) return;
  const status =
    args.state === 'failed'
      ? `Failed after ${args.elapsed}.`
      : args.state === 'delivery_incomplete'
        ? `Delivery incomplete after ${args.elapsed}.`
        : `Done in ${args.elapsed}.`;
  await args.send(status, args.options).catch((err) => args.onError?.(err));
}
