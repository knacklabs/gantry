import type { IpcDeps } from './ipc-domain-types.js';
import { resolveIpcFoldersFromGroups, resolveIpcTargetJidForSourceGroup } from './ipc-folder-resolve.js';
export type { IpcDeps } from './ipc-domain-types.js';
export { processTaskIpc } from '../jobs/ipc-handler.js';
export { validateIpcAuthRequest } from './ipc-auth-validation.js';
export { resolveIpcFoldersFromGroups, resolveIpcTargetJidForSourceGroup };
export { validatePermissionIpcJobExecutionTarget, validateUserQuestionIpcJobExecutionTarget, } from './ipc-scheduled-interaction-validation.js';
export declare function startIpcWatcher(deps: IpcDeps): void;
export declare function stopIpcWatcher(): void;
