import type { ProgressUpdateOptions } from '../domain/types.js';

export type FinalProgressState =
  | 'completed'
  | 'failed'
  | 'delivery_incomplete'
  | 'stopped';

export function buildDoneProgressOptions(
  threadId?: string,
  replaceOnly?: boolean,
  generation?: number,
): ProgressUpdateOptions {
  return {
    ...(threadId ? { threadId } : {}),
    done: true,
    ...(replaceOnly ? { replaceOnly: true } : {}),
    ...(generation !== undefined ? { generation } : {}),
  };
}

export function buildReplaceOnlyProgressOptions(
  threadId?: string,
  generation?: number,
): ProgressUpdateOptions {
  return {
    ...(threadId ? { threadId } : {}),
    replaceOnly: true,
    ...(generation !== undefined ? { generation } : {}),
  };
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
      ? 'I hit an issue.'
      : args.state === 'delivery_incomplete'
        ? 'I hit an issue.'
        : args.state === 'stopped'
          ? 'Stopped.'
          : 'Done.';
  await args.send(status, args.options).catch((err) => args.onError?.(err));
}
