export async function prepareNewSessionArchive(input) {
    try {
        if (input.prepareSessionArchive) {
            return (await input.prepareSessionArchive('new-session')) ?? undefined;
        }
        return async () => {
            await input.archiveCurrentSession('new-session');
        };
    }
    catch (err) {
        input.logger.warn({ group: input.groupName, err }, 'Session archive scheduling failed during /new; continuing with reset');
        return undefined;
    }
}
export function runNewSessionArchiveFinalizer(input) {
    if (!input.finalizeArchive)
        return;
    void input
        .finalizeArchive()
        .then(() => input.onSessionArchived?.('new-session'))
        .catch((err) => {
        input.logger.warn({ group: input.groupName, err }, 'Session archive failed during /new after reset');
    });
}
