/**
 * Thrown by the write path when a human `allow_once` is offered for persistence.
 * allow_once is ephemeral and must never enter decision memory.
 */
export class AllowOnceNeverPersistedError extends Error {
    constructor() {
        super('permission_decision_memory: human allow_once is never persisted');
        this.name = 'AllowOnceNeverPersistedError';
    }
}
