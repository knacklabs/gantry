import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, } from '@aws-sdk/client-s3';
import { ArtifactIntegrityError, } from '../../../domain/ports/browser-profile-artifact-store.js';
import { browserProfileStorageRefFor, hashBrowserProfileFiles, normalizeBrowserProfileFiles, normalizeBrowserProfileStorageRef, resolveBrowserProfileAssetPath, resolveBrowserProfileSymlinkTarget, } from './browser-profile-bundle.js';
/**
 * Content-addressed S3 browser profile snapshot store for fleet mode. Objects
 * live under `browser-profiles/<profileName>/<contentHash>/<relpath>`.
 * Materialize lists the recorded prefix, verifies sha256 against the recorded
 * hash, and atomically activates, quarantining on mismatch.
 *
 * IAM CONTRAST vs the toolchain store: toolchain artifacts are bake-rw /
 * worker-ro (workers never mutate capability state). Browser profiles are
 * SNAPSHOTTED BY WORKERS at turn end and RESTORED BY WORKERS at launch, so the
 * worker instance role needs READ-WRITE (GetObject/PutObject/DeleteObject) on
 * the `browser-profiles/` prefix. That grant is encoded in
 * ops/terraform/modules/storage/main.tf (worker_browser_rw policy) and attached
 * to the worker role in ops/terraform/envs/fleet/main.tf. See also
 * docs/deployment/aws-terraform.md.
 */
export class S3BrowserProfileArtifactStore {
    client;
    bucket;
    constructor(client, bucket) {
        this.client = client;
        this.bucket = bucket;
    }
    async putBrowserProfile(input) {
        const files = normalizeBrowserProfileFiles(input.files);
        const contentHash = hashBrowserProfileFiles(files);
        const storageRef = browserProfileStorageRefFor(input.profileName, contentHash);
        let sizeBytes = 0;
        for (const file of files) {
            const content = Buffer.from(file.content);
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: objectKey(storageRef, file.path),
                Body: content,
                Metadata: objectMetadata(file),
            }));
            sizeBytes += content.byteLength;
        }
        return {
            storageType: 'object-store',
            storageRef,
            contentHash,
            sizeBytes,
        };
    }
    async materializeBrowserProfile(input) {
        const files = await this.fetchBrowserProfileFiles(input.storageRef);
        const actualContentHash = hashBrowserProfileFiles(files);
        const targetDir = path.resolve(input.targetDir);
        await fs.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
        const tempDir = await fs.mkdtemp(path.join(path.dirname(targetDir), '.gantry-browser-profile-'));
        try {
            let sizeBytes = 0;
            for (const file of files) {
                const filePath = resolveBrowserProfileAssetPath(tempDir, file.path);
                await fs.mkdir(path.dirname(filePath), {
                    recursive: true,
                    mode: 0o700,
                });
                if ((file.kind ?? 'file') === 'symlink') {
                    await fs.symlink(resolveBrowserProfileSymlinkTarget(tempDir, file.path, file.linkTarget ?? ''), filePath);
                    continue;
                }
                const content = Buffer.from(file.content);
                await writeBrowserProfileFile(filePath, content, file.mode);
                sizeBytes += content.byteLength;
            }
            if (actualContentHash !== input.expectedContentHash) {
                const quarantinePath = await this.quarantine(tempDir, input.quarantineDir, input.storageRef);
                throw new ArtifactIntegrityError({
                    storageRef: input.storageRef,
                    expectedContentHash: input.expectedContentHash,
                    actualContentHash,
                    quarantinePath,
                });
            }
            await fs.rm(targetDir, { recursive: true, force: true });
            await fs.rename(tempDir, targetDir);
            return {
                storageRef: input.storageRef,
                contentHash: actualContentHash,
                targetDir,
                sizeBytes,
            };
        }
        finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }
    async fetchBrowserProfileFiles(storageRef) {
        const prefix = `${normalizeBrowserProfileStorageRef(storageRef)}/`;
        const keys = await this.listPrefix(prefix);
        const files = [];
        for (const key of keys) {
            const relative = key.slice(prefix.length);
            if (!relative)
                continue;
            const object = await this.getObject(key);
            files.push({
                path: relative,
                kind: object.kind,
                mode: object.mode,
                linkTarget: object.linkTarget,
                content: new Uint8Array(object.content),
            });
        }
        return files;
    }
    async quarantine(sourceDir, quarantineRoot, storageRef) {
        const root = path.resolve(quarantineRoot);
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        // Random suffix: concurrent integrity failures for the same storageRef must
        // never collapse onto one path and destroy a forensic copy.
        const stamp = `${storageRef.replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now()}-${randomUUID()}`;
        const quarantinePath = path.join(root, stamp);
        await fs.rm(quarantinePath, { recursive: true, force: true });
        await fs.rename(sourceDir, quarantinePath);
        return quarantinePath;
    }
    async listPrefix(prefix) {
        const keys = [];
        let continuationToken;
        do {
            const response = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }));
            for (const entry of response.Contents ?? []) {
                if (entry.Key)
                    keys.push(entry.Key);
            }
            continuationToken = response.IsTruncated
                ? response.NextContinuationToken
                : undefined;
        } while (continuationToken);
        return keys;
    }
    async getObject(key) {
        const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        const body = response.Body;
        if (!body || typeof body.transformToByteArray !== 'function') {
            throw new Error(`S3 object ${key} returned no readable body`);
        }
        const metadata = response.Metadata ?? {};
        const kind = metadata['gantry-kind'] === 'symlink' ? 'symlink' : 'file';
        const mode = metadata['gantry-mode']
            ? Number.parseInt(metadata['gantry-mode'], 8)
            : undefined;
        return {
            content: Buffer.from(await body.transformToByteArray()),
            kind,
            mode: Number.isFinite(mode) ? mode : undefined,
            linkTarget: decodeLinkTarget(metadata),
        };
    }
}
async function writeBrowserProfileFile(filePath, content, mode) {
    const fileMode = mode ?? 0o600;
    await fs.writeFile(filePath, content, { mode: fileMode });
    await fs.chmod(filePath, fileMode);
}
function objectKey(storageRef, relative) {
    return `${normalizeBrowserProfileStorageRef(storageRef)}/${relative}`;
}
function objectMetadata(file) {
    const metadata = {
        'gantry-kind': file.kind ?? 'file',
    };
    if (file.mode !== undefined) {
        metadata['gantry-mode'] = file.mode.toString(8);
    }
    if (file.linkTarget !== undefined) {
        metadata['gantry-link-target-b64'] = Buffer.from(file.linkTarget, 'utf8').toString('base64');
    }
    return metadata;
}
function decodeLinkTarget(metadata) {
    const encoded = metadata['gantry-link-target-b64'];
    if (encoded) {
        return Buffer.from(encoded, 'base64').toString('utf8');
    }
    return metadata['gantry-link-target'];
}
