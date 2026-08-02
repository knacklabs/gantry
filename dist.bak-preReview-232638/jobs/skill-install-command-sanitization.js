import { toTrimmedString } from './ipc-shared.js';
export function redactCommandOutput(value) {
    return value.replace(/[A-Za-z0-9_=-]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_=-]*/gi, '<redacted>');
}
export function sanitizedStringList(values) {
    return [
        ...new Set(values
            .slice(0, 50)
            .map((item) => toTrimmedString(item, { maxLen: 512 }))
            .filter((item) => Boolean(item))),
    ];
}
