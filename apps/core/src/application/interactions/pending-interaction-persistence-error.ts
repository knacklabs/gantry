export class DurableInteractionPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DurableInteractionPersistenceError';
  }
}
