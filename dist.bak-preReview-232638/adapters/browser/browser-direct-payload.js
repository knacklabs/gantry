import { normalizeBrowserFilePayload } from './browser-artifact-policy.js';
export function normalizeBrowserDirectPayload(toolName, payload, options) {
    const fileNormalized = normalizeBrowserFilePayload(toolName, payload, options);
    if (toolName !== 'fill_form')
        return fileNormalized;
    const fields = fileNormalized.fields;
    if (!Array.isArray(fields))
        return fileNormalized;
    return {
        ...fileNormalized,
        fields: fields.map((field) => {
            if (!field || typeof field !== 'object' || Array.isArray(field)) {
                return field;
            }
            const row = field;
            const target = stringValue(row.target);
            if (!target)
                return field;
            return {
                ...row,
                target,
                element: stringValue(row.element) || stringValue(row.name) || target,
                name: stringValue(row.name) || stringValue(row.element) || target,
                type: normalizeFieldType(row.type, row.value),
                value: normalizeFieldValue(row.value),
            };
        }),
    };
}
export function formFields(value) {
    if (!Array.isArray(value)) {
        throw new Error('fill_form fields must be an array.');
    }
    return value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('fill_form field entries must be objects.');
        }
        const row = item;
        return {
            target: requiredString(row.target, 'target'),
            type: normalizeFieldType(row.type, row.value),
            value: normalizeFieldValue(row.value),
        };
    });
}
function normalizeFieldType(value, fieldValue) {
    if (value === 'textbox' ||
        value === 'checkbox' ||
        value === 'radio' ||
        value === 'combobox' ||
        value === 'slider') {
        return value;
    }
    return typeof fieldValue === 'boolean' ? 'checkbox' : 'textbox';
}
function normalizeFieldValue(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return String(value ?? '');
}
function requiredString(value, name) {
    const normalized = stringValue(value);
    if (!normalized)
        throw new Error(`Browser action requires ${name}.`);
    return normalized;
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
