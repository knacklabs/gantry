import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import { controlApiRequest } from './control-api.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
const errorMessage = (err) => err instanceof Error ? err.message : String(err);
const PROFILE_KINDS = ['soul', 'agents'];
const PROFILE_FILE_NAMES = {
    soul: 'SOUL.md',
    agents: 'AGENTS.md',
};
const PROFILE_MIRROR_FILE_NAMES = {
    soul: 'SOUL.md',
    agents: 'AGENTS.profile.md',
};
// Kept in sync with platform/profile-file-mirror.ts (adapters cannot import the
// runtime layer directly).
const PROFILE_MIRROR_HEADER = '<!-- Managed by Gantry. Direct edits are not active until imported or approved. -->';
const WORKSPACE_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_WORKSPACE_FOLDERS = new Set(['global', 'shared']);
function isValidWorkspaceFolder(folder) {
    if (!folder)
        return false;
    if (folder !== folder.trim())
        return false;
    if (!WORKSPACE_FOLDER_PATTERN.test(folder))
        return false;
    if (folder.includes('/') || folder.includes('\\'))
        return false;
    if (folder.includes('..'))
        return false;
    if (RESERVED_WORKSPACE_FOLDERS.has(folder.toLowerCase()))
        return false;
    return true;
}
function stripMirrorHeader(content) {
    const normalized = content.replace(/^\uFEFF/, '');
    if (!normalized.startsWith(PROFILE_MIRROR_HEADER))
        return content;
    return normalized
        .slice(PROFILE_MIRROR_HEADER.length)
        .replace(/^\r?\n\r?\n?/, '');
}
function isProfileKind(value) {
    return (typeof value === 'string' &&
        PROFILE_KINDS.includes(value));
}
async function resolveProfileSelector(runtimeHome, value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('agent:')) {
        const folder = trimmed.slice('agent:'.length);
        return { agentId: trimmed, folder };
    }
    if (isValidWorkspaceFolder(trimmed)) {
        return { agentId: `agent:${trimmed}`, folder: trimmed };
    }
    const db = await openRuntimeGroupDb(runtimeHome);
    try {
        const route = (await db.getAllConversationRoutes())[trimmed];
        if (route?.folder) {
            return { agentId: `agent:${route.folder}`, folder: route.folder };
        }
    }
    finally {
        await db.close();
    }
    throw new Error(`No agent found for selector ${trimmed}.`);
}
function mirrorPath(runtimeHome, folder, kind) {
    return path.join(runtimeHome, 'agents', folder, PROFILE_MIRROR_FILE_NAMES[kind]);
}
function profileUsage() {
    p.log.error([
        'Usage:',
        '  gantry agent profile list <agent>',
        '  gantry agent profile read <agent> <soul|agents>',
        '  gantry agent profile set <agent> <soul|agents> --file <path|-> [--expect-version N]',
        '  gantry agent profile import <agent> <soul|agents>',
        '  gantry agent profile export <agent> [<soul|agents>]',
    ].join('\n'));
}
async function putProfileFile(runtimeHome, selector, kind, content, expectedVersion) {
    const resolved = await resolveProfileSelector(runtimeHome, selector);
    const agentId = encodeURIComponent(resolved.agentId);
    return controlApiRequest(runtimeHome, {
        method: 'PUT',
        path: `/v1/agents/${agentId}/profile-files/${kind}`,
        body: {
            content,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        },
    });
}
export async function runProfile(runtimeHome, rest) {
    const [action, selector, ...args] = rest;
    if (!action || !selector) {
        profileUsage();
        return 1;
    }
    try {
        const resolved = await resolveProfileSelector(runtimeHome, selector);
        const agentId = encodeURIComponent(resolved.agentId);
        if (action === 'list') {
            const result = await controlApiRequest(runtimeHome, {
                method: 'GET',
                path: `/v1/agents/${agentId}/profile-files`,
            });
            console.log(JSON.stringify(result, null, 2));
            return 0;
        }
        if (action === 'read') {
            const kind = args[0];
            if (!isProfileKind(kind)) {
                profileUsage();
                return 1;
            }
            const result = (await controlApiRequest(runtimeHome, {
                method: 'GET',
                path: `/v1/agents/${agentId}/profile-files/${kind}`,
            }));
            console.log(result.content ?? '');
            return 0;
        }
        if (action === 'set') {
            const kind = args[0];
            if (!isProfileKind(kind)) {
                profileUsage();
                return 1;
            }
            const fileIndex = args.indexOf('--file');
            const filePath = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
            if (!filePath) {
                p.log.error('set requires --file <path|-> (use - for stdin).');
                return 1;
            }
            const expectIndex = args.indexOf('--expect-version');
            const expectedVersion = expectIndex >= 0 ? Number(args[expectIndex + 1]) : undefined;
            if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
                p.log.error('--expect-version requires an integer.');
                return 1;
            }
            const content = filePath === '-'
                ? fs.readFileSync(0, 'utf-8')
                : fs.readFileSync(path.resolve(filePath), 'utf-8');
            const result = await putProfileFile(runtimeHome, selector, kind, content, expectedVersion);
            console.log(JSON.stringify(result, null, 2));
            return 0;
        }
        if (action === 'import') {
            const kind = args[0];
            if (!isProfileKind(kind)) {
                profileUsage();
                return 1;
            }
            const localPath = mirrorPath(runtimeHome, resolved.folder, kind);
            if (!fs.existsSync(localPath)) {
                p.log.error(`No mirror file to import at ${localPath}`);
                return 1;
            }
            const content = stripMirrorHeader(fs.readFileSync(localPath, 'utf-8'));
            const result = await putProfileFile(runtimeHome, selector, kind, content, undefined);
            p.log.success(`Imported ${PROFILE_FILE_NAMES[kind]} from ${localPath}.`);
            console.log(JSON.stringify(result, null, 2));
            return 0;
        }
        if (action === 'export') {
            const requested = args[0];
            const kinds = isProfileKind(requested)
                ? [requested]
                : [...PROFILE_KINDS];
            const folder = resolved.folder;
            for (const kind of kinds) {
                const file = (await controlApiRequest(runtimeHome, {
                    method: 'GET',
                    path: `/v1/agents/${agentId}/profile-files/${kind}`,
                }));
                const localPath = mirrorPath(runtimeHome, folder, kind);
                fs.mkdirSync(path.dirname(localPath), { recursive: true, mode: 0o700 });
                const rendered = `${PROFILE_MIRROR_HEADER}\n\n${stripMirrorHeader(file.content ?? '')}`;
                const tmpPath = `${localPath}.tmp`;
                fs.writeFileSync(tmpPath, rendered, { mode: 0o600 });
                fs.renameSync(tmpPath, localPath);
                p.log.success(`Exported ${PROFILE_FILE_NAMES[kind]} to ${localPath}.`);
            }
            return 0;
        }
        profileUsage();
        return 1;
    }
    catch (err) {
        p.log.error(`Agent profile command failed: ${errorMessage(err)}`);
        return 1;
    }
}
