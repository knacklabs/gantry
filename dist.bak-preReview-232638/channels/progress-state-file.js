import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { logger } from '../infrastructure/logging/logger.js';
export function channelProgressStateFilePath(channel, token) {
    const runtimeHome = process.env.GANTRY_HOME?.trim();
    if (!runtimeHome)
        return null;
    const tokenHash = createHash('sha256')
        .update(token)
        .digest('hex')
        .slice(0, 16);
    return path.join(runtimeHome, 'run', `${channel}-progress-state-${tokenHash}.json`);
}
export function readProgressStateEntries(filePath, channel) {
    if (!filePath)
        return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(parsed))
            return [];
        return parsed.flatMap((entry) => {
            if (!Array.isArray(entry) || entry.length !== 2)
                return [];
            const [key, state] = entry;
            if (typeof key !== 'string' ||
                typeof state !== 'object' ||
                state === null) {
                return [];
            }
            return [[key, state]];
        });
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            logger.debug({ err }, `Failed to load ${channel} progress state`);
        }
        return [];
    }
}
export function writeProgressStateEntries(filePath, channel, entries) {
    if (!filePath)
        return;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(Array.from(entries)));
        fs.renameSync(tmpPath, filePath);
    }
    catch (err) {
        logger.debug({ err }, `Failed to persist ${channel} progress state`);
    }
}
