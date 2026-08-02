import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PRIVATE_FILE_MODE } from './private-fs.js';
// macOS 11+ defines O_NOFOLLOW_ANY, but Node does not export it.
const O_NOFOLLOW_ANY = 0x20000000;
const MAX_FILE_COMPONENT_BYTES = 255;
const STORAGE_ID_PREFIX_BYTES = 17;
const TEMP_NAME_WRAPPER_BYTES = 1 + 1 + 32 + 4;
const MAX_STORAGE_FILENAME_BYTES = MAX_FILE_COMPONENT_BYTES - STORAGE_ID_PREFIX_BYTES - TEMP_NAME_WRAPPER_BYTES;
export function createInboundAttachmentStorageRef(filename) {
    const sanitized = filename.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = sanitized && sanitized !== '.' && sanitized !== '..'
        ? sanitized
        : 'attachment.bin';
    const boundedName = truncateFilenamePreservingExtension(safeName, MAX_STORAGE_FILENAME_BYTES);
    return path.posix.join('attachments', `${randomBytes(8).toString('hex')}-${boundedName}`);
}
export async function writeInboundAttachment(input) {
    if (!isSafeWorkspaceRelativePath(input.workspaceRelativePath)) {
        throw new Error('Invalid inbound attachment path');
    }
    const workspaceRoot = await fs.realpath(input.workspaceRoot);
    const requestedPath = path.resolve(workspaceRoot, input.workspaceRelativePath);
    assertContained(workspaceRoot, requestedPath);
    const directoryPath = await fs.realpath(path.dirname(requestedPath));
    assertContained(workspaceRoot, directoryPath);
    const finalName = path.basename(requestedPath);
    const directory = await openContainedDirectory(directoryPath);
    const tempName = `.${finalName}.${randomBytes(16).toString('hex')}.tmp`;
    let temp = null;
    try {
        temp = await fs.open(directoryEntryPath(directory, directoryPath, tempName), fileOpenFlags(fsConstants.O_RDWR), PRIVATE_FILE_MODE);
        await assertOpenedFileBinding({
            directory,
            directoryPath,
            file: temp,
            fileName: tempName,
        });
        const result = isInboundAttachmentReader(input.content)
            ? await writeStream(temp, input.content, input.maxBytes)
            : await writeBuffer(temp, input.content, input.maxBytes);
        if (result.status === 'too-large')
            return result;
        await temp.chmod(PRIVATE_FILE_MODE);
        await temp.sync();
        await assertOpenedFileBinding({
            directory,
            directoryPath,
            file: temp,
            fileName: tempName,
        });
        await fs.rename(directoryEntryPath(directory, directoryPath, tempName), directoryEntryPath(directory, directoryPath, finalName));
        return result;
    }
    finally {
        try {
            if (temp) {
                try {
                    // ponytail: Node exposes no portable *at unlink on Darwin; random temp names plus directory-descriptor validation are the mitigation for path-based cleanup.
                    await removeBoundFile(directory, directoryPath, temp, tempName);
                }
                catch (error) {
                    if (!isNotFoundError(error))
                        throw error;
                }
                finally {
                    await temp.close();
                }
            }
        }
        finally {
            await directory.close();
        }
    }
}
async function openContainedDirectory(directoryPath) {
    const directory = await fs.open(directoryPath, directoryOpenFlags());
    try {
        await assertOpenedDirectoryBinding(directory, directoryPath);
        return directory;
    }
    catch (error) {
        await directory.close();
        throw error;
    }
}
async function assertOpenedDirectoryBinding(directory, directoryPath) {
    const descriptorStat = await directory.stat();
    const pathStat = await fs.lstat(directoryPath);
    if (!descriptorStat.isDirectory() ||
        !pathStat.isDirectory() ||
        pathStat.isSymbolicLink() ||
        descriptorStat.dev !== pathStat.dev ||
        descriptorStat.ino !== pathStat.ino) {
        throw new Error('Inbound attachment directory changed during write');
    }
    if (process.platform === 'linux') {
        const descriptorPath = await fs.realpath(`/proc/self/fd/${directory.fd}`);
        if (descriptorPath !== directoryPath) {
            throw new Error('Inbound attachment directory changed during write');
        }
    }
}
async function assertOpenedFileBinding(input) {
    if (process.platform === 'darwin') {
        await assertOpenedDirectoryBinding(input.directory, input.directoryPath);
    }
    const descriptorStat = await input.file.stat();
    const entryPath = directoryEntryPath(input.directory, input.directoryPath, input.fileName);
    const pathStat = await fs.lstat(entryPath);
    if (!descriptorStat.isFile() ||
        !pathStat.isFile() ||
        pathStat.isSymbolicLink() ||
        descriptorStat.dev !== pathStat.dev ||
        descriptorStat.ino !== pathStat.ino ||
        descriptorStat.nlink !== 1) {
        throw new Error('Inbound attachment file changed during write');
    }
    if (process.platform === 'linux') {
        const descriptorPath = await fs.realpath(`/proc/self/fd/${input.file.fd}`);
        const entryRealPath = await fs.realpath(entryPath);
        if (descriptorPath !== entryRealPath) {
            throw new Error('Inbound attachment file changed during write');
        }
    }
}
async function removeBoundFile(directory, directoryPath, file, fileName) {
    await assertOpenedFileBinding({
        directory,
        directoryPath,
        file,
        fileName,
    });
    await fs.unlink(directoryEntryPath(directory, directoryPath, fileName));
}
async function writeBuffer(file, content, maxBytes) {
    if (content.byteLength > maxBytes) {
        return { status: 'too-large', bytes: content.byteLength };
    }
    await writeAll(file, content);
    return { status: 'written', bytes: content.byteLength };
}
async function writeStream(file, reader, maxBytes) {
    let bytes = 0;
    while (true) {
        const chunk = await reader.read();
        if (chunk.done)
            return { status: 'written', bytes };
        if (!chunk.value || chunk.value.byteLength === 0)
            continue;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes)
            return { status: 'too-large', bytes };
        await writeAll(file, chunk.value);
    }
}
async function writeAll(file, content) {
    let offset = 0;
    while (offset < content.byteLength) {
        const { bytesWritten } = await file.write(content, offset, content.byteLength - offset);
        if (bytesWritten === 0) {
            throw new Error('Failed to write inbound attachment');
        }
        offset += bytesWritten;
    }
}
function directoryOpenFlags() {
    if (process.platform === 'darwin') {
        return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | O_NOFOLLOW_ANY;
    }
    if (process.platform === 'linux') {
        return (fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    }
    throw new Error('Inbound attachment writes are unsupported on this platform');
}
function fileOpenFlags(accessMode) {
    const noFollow = process.platform === 'darwin'
        ? O_NOFOLLOW_ANY
        : process.platform === 'linux'
            ? fsConstants.O_NOFOLLOW
            : directoryOpenFlags();
    return accessMode | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
}
function directoryEntryPath(directory, directoryPath, fileName) {
    if (process.platform === 'linux') {
        return `/proc/self/fd/${directory.fd}/${fileName}`;
    }
    if (process.platform === 'darwin') {
        return path.join(directoryPath, fileName);
    }
    throw new Error('Inbound attachment writes are unsupported on this platform');
}
function assertContained(rootPath, candidatePath) {
    const relative = path.relative(rootPath, candidatePath);
    if (relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        throw new Error('Inbound attachment path escapes the workspace');
    }
}
function isNotFoundError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT');
}
function truncateFilenamePreservingExtension(filename, maxBytes) {
    if (Buffer.byteLength(filename) <= maxBytes)
        return filename;
    const extension = path.posix.extname(filename);
    if (!extension)
        return truncateEncodedPrefix(filename, maxBytes);
    const extensionBytes = Buffer.byteLength(extension);
    if (extensionBytes >= maxBytes) {
        return truncateEncodedPrefix(extension, maxBytes);
    }
    const stem = filename.slice(0, -extension.length);
    return `${truncateEncodedPrefix(stem, maxBytes - extensionBytes)}${extension}`;
}
function truncateEncodedPrefix(value, maxBytes) {
    let result = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character);
        if (bytes + characterBytes > maxBytes)
            break;
        result += character;
        bytes += characterBytes;
    }
    return result;
}
function isSafeWorkspaceRelativePath(value) {
    return (Boolean(value.trim()) &&
        !value.includes('\0') &&
        !path.isAbsolute(value) &&
        !path.win32.isAbsolute(value) &&
        !value.split(/[\\/]/).includes('..'));
}
function isInboundAttachmentReader(value) {
    return 'read' in value;
}
