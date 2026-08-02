export interface OperatorErrorReceipt {
    summary: string;
    cause: string;
    recover: string;
}
export declare function formatOperatorError(receipt: OperatorErrorReceipt): string;
