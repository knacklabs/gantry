import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../../infrastructure/logging/logger.js';
import { createInboundAttachmentStorageRef } from '../../shared/inbound-attachment-writer.js';
import { ensurePrivateDirSync } from '../../shared/private-fs.js';
import { writeSlackAttachmentResponse } from './attachment-download.js';

export interface SlackAttachmentDownload {
  filePath: string;
  storageRef: string;
}

export type SlackAttachmentDownloadResult =
  | { status: 'downloaded'; download: SlackAttachmentDownload }
  | { status: 'unavailable'; reason: string };

export async function downloadSlackAttachmentToFolder(input: {
  botToken: string;
  jid: string;
  filename: string;
  url: string;
  groupDir: string;
}): Promise<SlackAttachmentDownloadResult> {
  const storageRef = createInboundAttachmentStorageRef(input.filename);
  try {
    const attachDir = path.join(input.groupDir, 'attachments');
    ensurePrivateDirSync(attachDir);
    const destPath = path.join(input.groupDir, ...storageRef.split('/'));
    const resp = await fetch(input.url, {
      headers: {
        authorization: `Bearer ${input.botToken}`,
      },
    });
    if (!resp.ok) {
      logger.warn(
        { jid: input.jid, status: resp.status, filename: input.filename },
        'Failed to download Slack attachment',
      );
      return { status: 'unavailable', reason: `slack_http_${resp.status}` };
    }
    if (isLikelySlackHtmlResponse(resp, input.filename)) {
      logger.warn(
        {
          jid: input.jid,
          filename: input.filename,
          contentType: resp.headers.get('content-type') ?? null,
        },
        'Slack attachment download returned HTML instead of file content',
      );
      return { status: 'unavailable', reason: 'slack_html_response' };
    }

    const wrote = await writeSlackAttachmentResponse(
      resp,
      input.groupDir,
      storageRef,
    );
    if (!wrote) return { status: 'unavailable', reason: 'write_rejected' };
    const stat = fs.statSync(destPath);
    if (!stat.isFile() || stat.size < 0) {
      logger.warn(
        { jid: input.jid, filename: input.filename, storageRef },
        'Slack attachment write did not produce a readable file',
      );
      return { status: 'unavailable', reason: 'written_file_unreadable' };
    }
    return {
      status: 'downloaded',
      download: { filePath: destPath, storageRef },
    };
  } catch (err) {
    if (isFileExistsError(err)) throw err;
    logger.warn(
      { jid: input.jid, err, filename: input.filename },
      'Slack attachment download failed',
    );
    return { status: 'unavailable', reason: 'download_failed' };
  }
}

function isLikelySlackHtmlResponse(resp: Response, filename: string): boolean {
  const contentType = resp.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html')) return false;

  const disposition =
    resp.headers.get('content-disposition')?.toLowerCase() ?? '';
  if (disposition.includes('attachment')) return false;

  return !/\.(?:html?|xhtml)$/i.test(filename);
}

function isFileExistsError(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && current.code === 'EEXIST') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
