import { redactString } from '../infrastructure/logging/logger.js';

export function writeRunnerDiagnostic(message: string): void {
  console.error(redactString(message));
}
