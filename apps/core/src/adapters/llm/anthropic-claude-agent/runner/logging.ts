import { redactString } from '../../../../infrastructure/logging/logger.js';

export function log(message: string): void {
  console.error(`[agent-runner] ${redactString(message)}`);
}
