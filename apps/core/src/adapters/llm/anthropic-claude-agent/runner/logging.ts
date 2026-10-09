import { writeRunnerDiagnostic } from '../../../../runner/logging.js';

export function log(message: string): void {
  writeRunnerDiagnostic(`[agent-runner] ${message}`);
}
