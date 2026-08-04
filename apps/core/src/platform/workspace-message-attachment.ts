import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import {
  MAX_MESSAGE_FILE_ATTACHMENT_BYTES,
  type WorkspaceMessageAttachmentResolution,
} from '../application/core-tools/send-message.js';
import { resolveWorkspaceFolderPath } from './workspace-folder.js';

// macOS 11+ defines O_NOFOLLOW_ANY, but Node does not export it from fs.constants.
const O_NOFOLLOW_ANY = 0x20000000;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

export async function readWorkspaceMessageAttachment(
  sourceAgentFolder: string,
  workspaceRelativePath: string,
): Promise<WorkspaceMessageAttachmentResolution> {
  try {
    if (!isSafeWorkspaceRelativePath(workspaceRelativePath)) {
      return {
        status: 'failed',
        reason:
          'invalid path: workspace path must be relative and cannot contain .. segments',
      };
    }
    const workspaceRoot = await fs.realpath(
      resolveWorkspaceFolderPath(sourceAgentFolder),
    );
    const canonicalPath = await fs.realpath(
      path.resolve(workspaceRoot, workspaceRelativePath),
    );
    const relative = path.relative(workspaceRoot, canonicalPath);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return {
        status: 'failed',
        reason: 'invalid path: resolved path escapes the workspace folder',
      };
    }
    const pathStat = await fs.lstat(canonicalPath);
    if (!pathStat.isFile()) {
      return {
        status: 'failed',
        reason: 'workspace path is not a regular file',
      };
    }

    // Symlink races are closed atomically around the opened descriptor: Darwin
    // rejects every symlink component at open time with O_NOFOLLOW_ANY, while
    // Linux re-resolves the fd through /proc/self/fd and checks containment.
    // Only the realpath'd canonicalPath may be opened here, never a raw user
    // path (even macOS /tmp is a symlink). Hardlink exfiltration is closed
    // below by requiring nlink === 1.
    const openFlags =
      process.platform === 'darwin'
        ? fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_NOFOLLOW_ANY
        : process.platform === 'linux'
          ? fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK
          : undefined;
    if (openFlags === undefined) {
      return {
        status: 'failed',
        reason: 'invalid path: canonical workspace path changed after open',
      };
    }

    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(canonicalPath, openFlags);
    } catch {
      return { status: 'failed', reason: 'workspace file could not be read' };
    }
    try {
      if (process.platform === 'linux') {
        let openedCanonicalPath: string;
        try {
          openedCanonicalPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
        } catch {
          return {
            status: 'failed',
            reason: 'invalid path: canonical workspace path changed after open',
          };
        }
        const openedRelative = path.relative(
          workspaceRoot,
          openedCanonicalPath,
        );
        if (
          openedRelative === '..' ||
          openedRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(openedRelative)
        ) {
          return {
            status: 'failed',
            reason: 'invalid path: canonical workspace path changed after open',
          };
        }
      }

      const stat = await handle.stat();
      if (!stat.isFile()) {
        return {
          status: 'failed',
          reason: 'workspace path is not a regular file',
        };
      }
      // ponytail: legitimate multiply-linked workspace files are vanishingly
      // rare; revisit this rejection only if a real workflow needs them.
      if (stat.nlink !== 1) {
        return { status: 'failed', reason: 'path is multiply linked' };
      }
      if (stat.size > MAX_MESSAGE_FILE_ATTACHMENT_BYTES) {
        return { status: 'failed', reason: 'exceeds 25 MB' };
      }

      const content = Buffer.allocUnsafe(stat.size + 1);
      let bytesRead = 0;
      while (bytesRead < content.byteLength) {
        const result = await handle.read(
          content,
          bytesRead,
          content.byteLength - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_MESSAGE_FILE_ATTACHMENT_BYTES) {
        return { status: 'failed', reason: 'exceeds 25 MB' };
      }
      if (bytesRead > stat.size) {
        return {
          status: 'failed',
          reason: 'workspace file changed while reading',
        };
      }
      const attachmentContent = content.subarray(0, bytesRead);
      return {
        status: 'resolved',
        attachment: {
          filename: path.basename(workspaceRelativePath),
          contentType:
            CONTENT_TYPES[path.extname(workspaceRelativePath).toLowerCase()] ??
            'application/octet-stream',
          sizeBytes: attachmentContent.byteLength,
          content: attachmentContent,
        },
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingPathError(error)) return { status: 'missing' };
    return { status: 'failed', reason: 'workspace file could not be read' };
  }
}

function isSafeWorkspaceRelativePath(value: string): boolean {
  return (
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..')
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
