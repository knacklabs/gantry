import { redactString } from '../../../../infrastructure/logging/logger.js';
export function log(message) {
    console.error(`[agent-runner] ${redactString(message)}`);
}
