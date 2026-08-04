import { Ajv } from 'ajv';
const validator = new Ajv({ allErrors: true, strict: false });
export const validateMcpOutputSchema = (outputSchema) => {
    if (typeof outputSchema !== 'boolean' && !isRecord(outputSchema)) {
        return null;
    }
    let validate;
    try {
        validate = validator.compile(outputSchema);
    }
    catch {
        return null;
    }
    return {
        validate: (value) => {
            const valid = validate(value);
            return { valid, errors: valid ? [] : formatErrors(validate) };
        },
    };
};
function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function formatErrors(validate) {
    const errors = validate.errors ?? [];
    if (errors.length === 0)
        return ['/ is invalid'];
    return errors.slice(0, 3).map((error) => {
        const path = error.instancePath || '/';
        return `${path} ${error.message ?? 'is invalid'}`;
    });
}
