export function buildReplaceOnlyProgressOptions(threadId, generation) {
    return {
        ...(threadId ? { threadId } : {}),
        replaceOnly: true,
        ...(generation !== undefined ? { generation } : {}),
    };
}
export async function sendFinalProgressUpdate(args) {
    if (!args.enabled)
        return;
    const status = args.state === 'failed'
        ? 'I hit an issue.'
        : args.state === 'delivery_incomplete'
            ? 'I hit an issue.'
            : args.state === 'stopped'
                ? 'Stopped.'
                : 'Done.';
    await args.send(status, args.options).catch((err) => args.onError?.(err));
}
