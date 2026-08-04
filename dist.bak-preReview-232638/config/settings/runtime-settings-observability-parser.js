import { parseBooleanValue } from './runtime-settings-parse-primitives.js';
function parseEndpoint(raw, fallback) {
    if (raw === undefined)
        return fallback;
    if (typeof raw !== 'string') {
        throw new Error('observability.tracing.endpoint must be a string');
    }
    return raw.trim();
}
function parseSampleRate(raw, fallback) {
    if (raw === undefined)
        return fallback;
    // The minimal settings YAML parser types decimal scalars as strings
    // (repo-wide decimal coercion breaks decimal-looking string ids such as
    // channel thread timestamps), so this field coerces numeric strings locally.
    const trimmed = typeof raw === 'string' ? raw.trim() : undefined;
    const value = trimmed !== undefined && trimmed !== '' && Number.isFinite(Number(trimmed))
        ? Number(trimmed)
        : raw;
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1) {
        throw new Error('observability.tracing.sample_rate must be a number between 0 and 1');
    }
    return value;
}
function parseEnvironment(raw) {
    if (raw === undefined)
        return undefined;
    if (typeof raw !== 'string') {
        throw new Error('observability.tracing.environment must be a string');
    }
    return raw.trim();
}
export function parseObservabilitySettings(raw) {
    const defaults = {
        tracing: {
            enabled: false,
            endpoint: '',
            captureContent: true,
            sampleRate: 1,
        },
    };
    if (raw === undefined)
        return defaults;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('observability must be a mapping');
    }
    const map = raw;
    for (const key of Object.keys(map)) {
        if (key !== 'tracing') {
            throw new Error(`observability.${key} is not supported. Configure observability.tracing.*.`);
        }
    }
    const tracingRaw = map.tracing;
    if (tracingRaw !== undefined &&
        (typeof tracingRaw !== 'object' ||
            tracingRaw === null ||
            Array.isArray(tracingRaw))) {
        throw new Error('observability.tracing must be a mapping');
    }
    const tracing = (tracingRaw ?? {});
    for (const key of Object.keys(tracing)) {
        if (key !== 'enabled' &&
            key !== 'endpoint' &&
            key !== 'capture_content' &&
            key !== 'sample_rate' &&
            key !== 'environment') {
            throw new Error(`observability.tracing.${key} is not supported. Configure enabled, endpoint, capture_content, sample_rate, or environment.`);
        }
    }
    return {
        tracing: {
            enabled: parseBooleanValue(tracing.enabled, 'observability.tracing.enabled', defaults.tracing.enabled),
            endpoint: parseEndpoint(tracing.endpoint, defaults.tracing.endpoint),
            captureContent: parseBooleanValue(tracing.capture_content, 'observability.tracing.capture_content', defaults.tracing.captureContent),
            sampleRate: parseSampleRate(tracing.sample_rate, defaults.tracing.sampleRate),
            environment: parseEnvironment(tracing.environment),
        },
    };
}
