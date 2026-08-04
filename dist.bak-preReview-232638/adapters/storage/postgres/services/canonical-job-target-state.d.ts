import type { Job } from '../../../../domain/repositories/domain-types.js';
export declare function parseSetupState(input: unknown): Job['setup_state'];
export declare function parseRequiredCapabilities(input: unknown): Job['required_capabilities'];
export declare function parseRecoveryIntent(input: unknown): Job['recovery_intent'];
