import { RICH_INTERACTION_NATIVE_FALLBACK_TEXT } from '../domain/types.js';
export const RICH_INTERACTION_FALLBACK_COPY = RICH_INTERACTION_NATIVE_FALLBACK_TEXT;
export const RICH_INTERACTION_OPEN_FORM_LABEL = 'Open form';
export const RICH_INTERACTION_SUBMIT_LABEL = 'Submit';
export const RICH_INTERACTION_CANCEL_LABEL = 'Cancel';
export const RICH_INTERACTION_REQUIRED_FIELDS_COPY = 'Complete the required fields before submitting.';
export const RICH_INTERACTION_SUBMITTED_BY_COPY = 'Submitted by';
export function richDescriptor(input) {
    return input.descriptor;
}
export function richFallbackText(input) {
    const item = richDescriptor(input);
    return (item.rich?.fallbackText || item.fallbackText || item.body || item.title);
}
function textLines(input) {
    const item = richDescriptor(input);
    const lines = [item.title, item.body].filter(Boolean);
    for (const detail of item.details ?? []) {
        lines.push(`${detail.label}: ${detail.value}`);
    }
    for (const option of item.options ?? []) {
        lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ''}`);
    }
    if (item.result?.message)
        lines.push(item.result.message);
    return lines.length ? lines : [richFallbackText(input)];
}
export function richSlackEscape(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
export function richHtmlEscape(text) {
    return richSlackEscape(text).replace(/"/g, '&quot;');
}
export function richTruncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
export function isRichForm(input) {
    return richDescriptor(input).rich?.kind === 'form';
}
function payloadLines(input) {
    const rich = richDescriptor(input).rich;
    const payload = rich?.payload ?? {};
    switch (rich?.kind) {
        case 'status':
            return [
                typeof payload.state === 'string' ? payload.state : '',
                typeof payload.status === 'string' ? payload.status : '',
                typeof payload.body === 'string' ? payload.body : '',
            ].filter(Boolean);
        case 'facts':
            return richArrayItems(payload.facts)
                .map((fact) => lineFromPair(fact, 'label', 'value'))
                .filter(Boolean);
        case 'list':
            return richArrayItems(payload.items)
                .map((item) => lineFromPair(item, 'text', 'detail') ||
                lineFromPair(item, 'title', 'description'))
                .filter(Boolean);
        case 'table':
            return tableLines(payload);
        case 'form':
            return [
                RICH_INTERACTION_REQUIRED_FIELDS_COPY,
                ...richArrayItems(payload.fields)
                    .map((field) => lineFromPair(field, 'label', 'type'))
                    .filter(Boolean),
            ];
        case 'media':
            return richArrayItems(payload.items)
                .map((item) => {
                const label = item.caption || item.alt || item.mime_type || 'Media';
                return lineFromPair({ ...item, label }, 'label', 'url');
            })
                .filter(Boolean);
        case 'progress':
            return [
                typeof payload.label === 'string' ? payload.label : '',
                typeof payload.value === 'number' ? `${payload.value}%` : '',
            ].filter(Boolean);
        default:
            return [];
    }
}
export function richArrayItems(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
        : [];
}
function lineFromPair(item, labelKey, valueKey) {
    const label = item[labelKey];
    const value = item[valueKey];
    return [label, value]
        .filter((part) => ['string', 'number', 'boolean'].includes(typeof part))
        .map(String)
        .join(': ');
}
function tableLines(payload) {
    const columns = richArrayItems(payload.columns);
    const rows = richArrayItems(payload.rows);
    const keys = columns
        .map((column) => column.key)
        .filter((key) => typeof key === 'string');
    return rows.slice(0, 10).map((row) => keys
        .map((key) => {
        const label = columns.find((column) => column.key === key)?.label ?? key;
        return `${label}: ${String(row[key] ?? '')}`;
    })
        .join(' | '));
}
export function richTextLines(input) {
    return [...textLines(input), ...payloadLines(input)].filter(Boolean);
}
export function richFormFields(input) {
    return isRichForm(input)
        ? richArrayItems(richDescriptor(input).rich?.payload.fields).slice(0, 5)
        : [];
}
