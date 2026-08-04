import type { SessionControlPort } from '../../application/sessions/session-interaction-module.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
type RuntimeControlRepository = ReturnType<typeof getRuntimeControlRepository>;
export declare function adaptSessionControlPort(control: RuntimeControlRepository): SessionControlPort;
export {};
