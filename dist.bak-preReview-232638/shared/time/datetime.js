export const systemClock = {
    now: () => new Date(),
    nowMs: () => Date.now(),
};
export function fixedClock(input) {
    const fixed = toDate(input);
    const fixedMs = fixed.getTime();
    return {
        now: () => new Date(fixedMs),
        nowMs: () => fixedMs,
    };
}
export function nowIso(clock = systemClock) {
    return new Date(clock.nowMs()).toISOString();
}
export function nowMs(clock = systemClock) {
    return clock.nowMs();
}
export function nowDate(clock = systemClock) {
    return clock.now();
}
export function toIso(input) {
    return toDate(input).toISOString();
}
export function parseIso(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
export function formatDurationMs(durationMs) {
    if (!Number.isFinite(durationMs))
        return '0ms';
    const sign = durationMs < 0 ? '-' : '';
    const abs = Math.abs(Math.round(durationMs));
    const parts = [];
    const hours = Math.floor(abs / 3_600_000);
    const minutes = Math.floor((abs % 3_600_000) / 60_000);
    const seconds = Math.floor((abs % 60_000) / 1_000);
    const milliseconds = abs % 1_000;
    if (hours > 0)
        parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0)
        parts.push(`${minutes}m`);
    if (seconds > 0 || minutes > 0 || hours > 0)
        parts.push(`${seconds}s`);
    parts.push(`${milliseconds}ms`);
    return `${sign}${parts.join(' ')}`;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function toDate(input) {
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid date input: ${String(input)}`);
    }
    return parsed;
}
