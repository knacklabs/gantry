export function formatOperatorError(receipt) {
    return [
        receipt.summary.trim(),
        `cause: ${receipt.cause.trim()}`,
        `recover: ${receipt.recover.trim()}`,
    ].join('\n');
}
