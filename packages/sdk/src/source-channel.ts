import { createHash } from 'node:crypto';
import { sourceMessageHashInput, type SourceMessage } from '@gantry/contracts';

/** Stable immutable source identity. Display names can refresh independently. */
export function hashSourceMessage(
  message: Omit<SourceMessage, 'contentHash'>,
): string {
  return createHash('sha256')
    .update(sourceMessageHashInput(message))
    .digest('hex');
}

export { SourceContextReceiptSchema } from '@gantry/contracts';
export type { SourceContextReceipt, SourceContextSource } from '@gantry/contracts';
import {sourceContextReceiptHashInput,type SourceContextReceipt} from '@gantry/contracts';
export function hashSourceContextReceipt(receipt:Omit<SourceContextReceipt,'receiptHash'>):string {
  return createHash('sha256').update(sourceContextReceiptHashInput(receipt)).digest('hex');
}
