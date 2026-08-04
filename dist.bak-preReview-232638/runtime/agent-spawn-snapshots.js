import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveWorkspaceIpcPath } from '../platform/workspace-folder.js';
import { nowIso } from '../shared/time/datetime.js';
const MAX_SNAPSHOT_DIGEST_CACHE_ENTRIES = 512;
const snapshotContentDigestCache = new Map();
function hashSnapshotContent(content) {
    return createHash('sha256').update(content).digest('hex');
}
function rememberSnapshotDigest(file, digest) {
    snapshotContentDigestCache.delete(file);
    snapshotContentDigestCache.set(file, digest);
    while (snapshotContentDigestCache.size > MAX_SNAPSHOT_DIGEST_CACHE_ENTRIES) {
        const oldest = snapshotContentDigestCache.keys().next().value;
        if (!oldest)
            break;
        snapshotContentDigestCache.delete(oldest);
    }
}
async function writeSnapshotJson(file, value) {
    const content = JSON.stringify(value, null, 2);
    const digest = hashSnapshotContent(content);
    if (snapshotContentDigestCache.get(file) === digest)
        return;
    const dir = path.dirname(file);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
        const current = await fs.promises.readFile(file, 'utf-8');
        if (current === content) {
            rememberSnapshotDigest(file, digest);
            return;
        }
    }
    catch (err) {
        const code = typeof err === 'object' && err && 'code' in err
            ? String(err.code)
            : '';
        if (code !== 'ENOENT')
            throw err;
    }
    const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await fs.promises.writeFile(tempFile, content, 'utf-8');
        await fs.promises.rename(tempFile, file);
        rememberSnapshotDigest(file, digest);
    }
    catch (err) {
        await fs.promises.rm(tempFile, { force: true }).catch(() => { });
        throw err;
    }
}
export function clearSnapshotWriteCacheForTests() {
    snapshotContentDigestCache.clear();
}
export async function writeGroupsSnapshot(workspaceFolder, groups, _registeredJids) {
    const workspaceIpcDir = resolveWorkspaceIpcPath(workspaceFolder);
    const groupsFile = path.join(workspaceIpcDir, 'available_groups.json');
    await writeSnapshotJson(groupsFile, {
        groups,
        lastSync: nowIso(),
    });
}
