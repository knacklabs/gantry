export class ApplicationError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'ApplicationError';
        this.details = options?.details;
    }
    details;
}
