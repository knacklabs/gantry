import path from 'path';
export function buildServicePath(homeDir) {
    const isWindows = process.platform === 'win32';
    const preferred = isWindows
        ? [
            path.dirname(process.execPath),
            path.join(homeDir, 'AppData', 'Roaming', 'npm'),
            'C:\\Program Files\\nodejs',
            'C:\\Windows\\System32',
            'C:\\Windows',
        ]
        : [
            path.dirname(process.execPath),
            `${homeDir}/.local/bin`,
            `${homeDir}/.npm-global/bin`,
            `${homeDir}/bin`,
            '/opt/homebrew/bin',
            '/opt/homebrew/sbin',
            '/usr/local/bin',
            '/usr/local/sbin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin',
        ];
    const seen = new Set();
    const merged = [];
    for (const entry of preferred) {
        const normalized = entry.trim();
        if (!normalized || !path.isAbsolute(normalized))
            continue;
        if (seen.has(normalized))
            continue;
        seen.add(normalized);
        merged.push(normalized);
    }
    return merged.join(path.delimiter);
}
