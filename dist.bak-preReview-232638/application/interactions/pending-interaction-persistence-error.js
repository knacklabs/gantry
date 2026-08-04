export class DurableInteractionPersistenceError extends Error {
    constructor(message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'DurableInteractionPersistenceError';
    }
}
