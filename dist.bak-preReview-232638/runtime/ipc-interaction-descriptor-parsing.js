import { isPlainObject, toTrimmedString } from '../shared/object.js';
const RICH_INTERACTION_KINDS = new Set([
    'status',
    'facts',
    'list',
    'table',
    'form',
    'media',
    'progress',
]);
const RICH_FORM_FIELD_TYPES = new Set(['text', 'textarea']);
function parseInteractionDetails(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const details = [];
    for (const item of raw.slice(0, 40)) {
        if (!isPlainObject(item))
            continue;
        const label = toTrimmedString(item.label, { maxLen: 120 });
        const value = toTrimmedString(item.value, { maxLen: 2000 });
        if (!label || !value)
            continue;
        details.push({
            label,
            value,
            ...(typeof item.mono === 'boolean' ? { mono: item.mono } : {}),
        });
    }
    return details.length ? details : undefined;
}
export function parseInteractionDescriptor(raw) {
    if (!isPlainObject(raw))
        return undefined;
    const id = toTrimmedString(raw.id, { maxLen: 128 });
    const title = toTrimmedString(raw.title, { maxLen: 200 });
    if (!id || !title)
        return undefined;
    const body = toTrimmedString(raw.body, { maxLen: 4000 });
    const fallbackText = toTrimmedString(raw.fallbackText, { maxLen: 20000 });
    const rich = parseRichInteractionDescriptor(raw.rich, fallbackText);
    const details = parseInteractionDetails(raw.details);
    const requestContext = isPlainObject(raw.requestContext)
        ? raw.requestContext
        : undefined;
    const capabilityId = toTrimmedString(requestContext?.capabilityId, {
        maxLen: 160,
    });
    const capabilityDisplayName = toTrimmedString(requestContext?.capabilityDisplayName, { maxLen: 200 });
    const toolName = toTrimmedString(requestContext?.toolName, { maxLen: 120 });
    const capabilityType = toTrimmedString(requestContext?.capabilityType, {
        maxLen: 120,
    });
    return {
        id,
        title,
        ...(body ? { body } : {}),
        ...(fallbackText ? { fallbackText } : {}),
        ...(rich ? { rich } : {}),
        ...(details ? { details } : {}),
        ...(capabilityId || capabilityDisplayName || toolName || capabilityType
            ? {
                requestContext: {
                    ...(capabilityId ? { capabilityId } : {}),
                    ...(capabilityDisplayName ? { capabilityDisplayName } : {}),
                    ...(toolName ? { toolName } : {}),
                    ...(capabilityType ? { capabilityType } : {}),
                },
            }
            : {}),
    };
}
function parseRichInteractionDescriptor(raw, descriptorFallbackText) {
    if (!isPlainObject(raw))
        return undefined;
    const kind = toTrimmedString(raw.kind, { maxLen: 32 });
    if (!RICH_INTERACTION_KINDS.has(kind)) {
        throw new Error('Invalid rich interaction kind');
    }
    const fallbackText = toTrimmedString(raw.fallbackText, { maxLen: 20000 }) ??
        descriptorFallbackText;
    if (!fallbackText) {
        throw new Error('Rich interaction fallbackText is required');
    }
    const payload = raw.payload === undefined ? {} : raw.payload;
    if (!isPlainObject(payload)) {
        throw new Error('Invalid rich interaction payload');
    }
    return {
        kind: kind,
        fallbackText,
        payload: parseRichInteractionPayload(kind, payload),
    };
}
function parseRichInteractionPayload(kind, payload) {
    switch (kind) {
        case 'status':
            return {
                ...(toTrimmedString(payload.state, { maxLen: 120 })
                    ? { state: toTrimmedString(payload.state, { maxLen: 120 }) }
                    : {}),
                ...(toTrimmedString(payload.status, { maxLen: 120 })
                    ? { status: toTrimmedString(payload.status, { maxLen: 120 }) }
                    : {}),
                ...(toTrimmedString(payload.body, { maxLen: 4000 })
                    ? { body: toTrimmedString(payload.body, { maxLen: 4000 }) }
                    : {}),
            };
        case 'facts':
            return {
                facts: parseRichObjectArray(payload.facts, 20, (item) => ({
                    label: requireRichString(item.label, 'fact label', 120),
                    value: requireRichString(item.value, 'fact value', 2000),
                })),
            };
        case 'list':
            return {
                ...(typeof payload.ordered === 'boolean'
                    ? { ordered: payload.ordered }
                    : {}),
                items: parseRichObjectArray(payload.items, 30, (item) => ({
                    text: requireRichString(item.text, 'list item text', 1000),
                    ...(toTrimmedString(item.detail, { maxLen: 2000 })
                        ? { detail: toTrimmedString(item.detail, { maxLen: 2000 }) }
                        : {}),
                })),
            };
        case 'table':
            return {
                columns: parseRichObjectArray(payload.columns, 10, (item) => ({
                    key: requireRichString(item.key, 'table column key', 80),
                    label: requireRichString(item.label, 'table column label', 120),
                })),
                rows: parseRichObjectArray(payload.rows, 20, (item) => parseRichScalarRecord(item, 10)),
            };
        case 'form':
            return {
                fields: parseRichObjectArray(payload.fields, 10, (item) => {
                    const type = requireRichString(item.type, 'form field type', 20);
                    if (!RICH_FORM_FIELD_TYPES.has(type)) {
                        throw new Error('Invalid rich form field type');
                    }
                    return {
                        id: requireRichString(item.id, 'form field id', 80),
                        label: requireRichString(item.label, 'form field label', 120),
                        type,
                        ...(typeof item.required === 'boolean'
                            ? { required: item.required }
                            : {}),
                    };
                }),
            };
        case 'media':
            return {
                items: parseRichObjectArray(payload.items, 10, (item) => ({
                    url: requireRichString(item.url, 'media url', 2000),
                    ...(toTrimmedString(item.alt, { maxLen: 200 })
                        ? { alt: toTrimmedString(item.alt, { maxLen: 200 }) }
                        : {}),
                    ...(toTrimmedString(item.caption, { maxLen: 500 })
                        ? { caption: toTrimmedString(item.caption, { maxLen: 500 }) }
                        : {}),
                    ...(toTrimmedString(item.mime_type, { maxLen: 120 })
                        ? { mime_type: toTrimmedString(item.mime_type, { maxLen: 120 }) }
                        : {}),
                })),
            };
        case 'progress': {
            const value = typeof payload.value === 'number' &&
                Number.isFinite(payload.value) &&
                payload.value >= 0 &&
                payload.value <= 100
                ? payload.value
                : undefined;
            return {
                ...(toTrimmedString(payload.label, { maxLen: 120 })
                    ? { label: toTrimmedString(payload.label, { maxLen: 120 }) }
                    : {}),
                ...(value === undefined ? {} : { value }),
                ...(typeof payload.done === 'boolean' ? { done: payload.done } : {}),
            };
        }
    }
}
function parseRichObjectArray(raw, maxItems, parse) {
    if (!Array.isArray(raw))
        throw new Error('Invalid rich payload array');
    return raw.slice(0, maxItems).map((item) => {
        if (!isPlainObject(item))
            throw new Error('Invalid rich payload item');
        return parse(item);
    });
}
function requireRichString(raw, label, maxLen) {
    const value = toTrimmedString(raw, { maxLen });
    if (!value)
        throw new Error(`Invalid rich ${label}`);
    return value;
}
function parseRichScalarRecord(raw, maxKeys) {
    const out = {};
    let seen = 0;
    for (const key of Object.keys(raw)) {
        if (seen >= maxKeys)
            break;
        const value = raw[key];
        if (typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null) {
            out[key.slice(0, 80)] =
                typeof value === 'string' ? value.slice(0, 2000) : value;
            seen += 1;
        }
    }
    return out;
}
