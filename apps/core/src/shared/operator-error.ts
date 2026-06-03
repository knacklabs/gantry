export interface OperatorErrorReceipt {
  summary: string;
  cause: string;
  recover: string;
}

export function formatOperatorError(receipt: OperatorErrorReceipt): string {
  return [
    receipt.summary.trim(),
    `cause: ${receipt.cause.trim()}`,
    `recover: ${receipt.recover.trim()}`,
  ].join('\n');
}
