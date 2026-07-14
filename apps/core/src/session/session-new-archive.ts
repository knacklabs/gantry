export type SessionArchiveFinalizer = () => Promise<void>;
export type PrepareSessionArchive = (
  cause: 'new-session',
) =>
  | Promise<SessionArchiveFinalizer | undefined>
  | SessionArchiveFinalizer
  | undefined;

export async function prepareNewSessionArchive(input: {
  groupName: string;
  logger: { warn(payload: unknown, message: string): void };
  prepareSessionArchive?: PrepareSessionArchive;
  archiveCurrentSession: (cause: 'new-session') => Promise<unknown>;
}): Promise<SessionArchiveFinalizer | undefined> {
  try {
    if (input.prepareSessionArchive) {
      return (await input.prepareSessionArchive('new-session')) ?? undefined;
    }
    return async () => {
      await input.archiveCurrentSession('new-session');
    };
  } catch (err) {
    input.logger.warn(
      { group: input.groupName, err },
      'Session archive scheduling failed during /new; continuing with reset',
    );
    return undefined;
  }
}

export function runNewSessionArchiveFinalizer(input: {
  groupName: string;
  logger: { warn(payload: unknown, message: string): void };
  finalizeArchive?: SessionArchiveFinalizer;
  onSessionArchived?: (cause: 'new-session') => Promise<void>;
}): void {
  if (!input.finalizeArchive) return;
  void input
    .finalizeArchive()
    .then(() => input.onSessionArchived?.('new-session'))
    .catch((err) => {
      input.logger.warn(
        { group: input.groupName, err },
        'Session archive failed during /new after reset',
      );
    });
}
