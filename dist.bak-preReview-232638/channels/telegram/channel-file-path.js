export function sanitizeTelegramFilePath(rawPath) {
    const normalized = rawPath.replace(/\\/g, '/').trim();
    if (!normalized)
        return null;
    if (normalized.startsWith('/') || normalized.includes('..'))
        return null;
    if (!/^[a-zA-Z0-9._/-]+$/.test(normalized))
        return null;
    return normalized;
}
