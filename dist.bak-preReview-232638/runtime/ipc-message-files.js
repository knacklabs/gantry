import { resolveCoreMessageAttachments } from '../application/core-tools/send-message.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
export function parseIpcMessageFiles(rawFiles) {
    if (!Array.isArray(rawFiles))
        return [];
    const files = [];
    for (const entry of rawFiles.slice(0, 5)) {
        if (!isPlainObject(entry))
            continue;
        if (entry.source !== undefined &&
            entry.source !== 'artifact' &&
            entry.source !== 'workspace') {
            throw new Error('Invalid IPC message file source');
        }
        const filePath = toTrimmedString(entry.path, { maxLen: 1024 });
        if (!filePath)
            continue;
        if (entry.source === 'workspace') {
            files.push({ source: 'workspace', path: filePath });
            continue;
        }
        const scope = toTrimmedString(entry.scope, { maxLen: 120 });
        files.push({
            source: 'artifact',
            ...(scope ? { scope } : {}),
            path: filePath,
            ...(typeof entry.version === 'number'
                ? { version: Math.floor(entry.version) }
                : {}),
        });
    }
    return files;
}
export async function appendOwnedFileArtifactDegradeText(input) {
    return (await resolveOwnedFileArtifactMessage(input)).text;
}
export async function resolveOwnedFileArtifactMessage(input) {
    return resolveCoreMessageAttachments({
        appId: input.appId,
        sourceAgentFolder: input.sourceAgentFolder,
        text: input.text,
        files: input.files,
        store: input.deps.getFileArtifactStore?.(),
    });
}
