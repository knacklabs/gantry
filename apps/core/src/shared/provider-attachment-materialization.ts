import fs from 'node:fs/promises';
import path from 'node:path';

import {
  extractDocumentText,
  sniffAttachmentKind,
  sniffDeliverableImageMime,
} from './provider-attachment-extraction.js';
import {
  createInboundAttachmentStorageRef,
  writeInboundAttachment,
} from './inbound-attachment-writer.js';

const PROVIDER_ATTACHMENT_STORAGE_PREFIX = 'provider-attachments/';
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_TEXT_OUTPUT_BYTES = 80_000;
const MAX_BINARY_OUTPUT_BYTES = 60_000;

const DOCUMENT_EXTENSIONS = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.pdf',
  '.rtf',
]);
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt']);

interface ReadableAttachmentMetadata {
  fileName?: string;
  contentType?: string;
}

export interface AttachmentImagePayload {
  base64: string;
  mimeType: string;
}

export type DocumentTextExtractor = (
  filePath: string,
  attachment: ReadableAttachmentMetadata,
) => Promise<string>;

export type ProviderAttachmentWriter = typeof writeInboundAttachment;
export const providerAttachmentWriter: ProviderAttachmentWriter =
  writeInboundAttachment;
export const PROVIDER_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export function createProviderAttachmentStorageRef(fileName: string): string {
  const liveStorageRef = createInboundAttachmentStorageRef(fileName);
  return `${PROVIDER_ATTACHMENT_STORAGE_PREFIX}${path.posix.basename(liveStorageRef)}`;
}

export function isProviderAttachmentStorageRef(storageRef: string): boolean {
  return storageRef.startsWith(PROVIDER_ATTACHMENT_STORAGE_PREFIX);
}

export async function materializeProviderAttachment(input: {
  materializationRoot: string;
  workspaceRoots: readonly string[];
  storageRef: string;
  content: Parameters<ProviderAttachmentWriter>[0]['content'];
  maxBytes: number;
  writer: ProviderAttachmentWriter;
}) {
  const root = await prepareMaterializationRoot(
    input.materializationRoot,
    input.workspaceRoots,
  );
  const storagePath = providerAttachmentStoragePath(input.storageRef);
  await fs.mkdir(path.join(root, path.dirname(storagePath)), {
    recursive: true,
  });
  return input.writer({
    workspaceRoot: root,
    workspaceRelativePath: storagePath,
    content: input.content,
    maxBytes: input.maxBytes,
  });
}

export function createProviderAttachmentMaterializer(input: {
  materializationRoot: string;
  workspaceRoots: () => readonly string[];
  writer?: ProviderAttachmentWriter;
}) {
  return async (attachment: {
    fileName: string;
    content: {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      cancel: (reason?: unknown) => Promise<void>;
    };
  }) => {
    const storageRef = createProviderAttachmentStorageRef(attachment.fileName);
    let result;
    try {
      result = await materializeProviderAttachment({
        materializationRoot: input.materializationRoot,
        workspaceRoots: input.workspaceRoots(),
        storageRef,
        content: attachment.content,
        maxBytes: PROVIDER_ATTACHMENT_MAX_BYTES,
        writer: input.writer ?? providerAttachmentWriter,
      });
    } catch (error) {
      await attachment.content.cancel(error).catch(() => undefined);
      throw error;
    }
    if (result.status === 'too-large') {
      await attachment.content.cancel('too_large').catch(() => undefined);
      throw new Error('Provider attachment exceeds max allowed size');
    }
    return {
      storageRef,
      reclaim: () =>
        removeProviderAttachment({
          materializationRoot: input.materializationRoot,
          workspaceRoots: input.workspaceRoots(),
          storageRef,
        }),
    };
  };
}

export async function removeProviderAttachment(input: {
  materializationRoot: string;
  workspaceRoots: readonly string[];
  storageRef: string;
}): Promise<void> {
  const root = await prepareMaterializationRoot(
    input.materializationRoot,
    input.workspaceRoots,
  );
  const storagePath = providerAttachmentStoragePath(input.storageRef);
  await fs.rm(path.join(root, ...storagePath.split('/')), { force: true });
}

export async function readProviderAttachment(input: {
  materializationRoot: string;
  workspaceRoots: readonly string[];
  storageRef: string;
  attachment: ReadableAttachmentMetadata;
  extract?: DocumentTextExtractor;
}): Promise<
  | {
      status: 'opened';
      content: string;
      image?: AttachmentImagePayload;
      materializedPath: string;
    }
  | { status: 'missing' }
> {
  const root = await prepareMaterializationRoot(
    input.materializationRoot,
    input.workspaceRoots,
  );
  const materializedPath = path.join(
    root,
    ...providerAttachmentStoragePath(input.storageRef).split('/'),
  );
  try {
    const read = await readAttachmentContent(
      materializedPath,
      input.attachment,
      input.extract ?? extractDocumentText,
    );
    return {
      status: 'opened',
      content: read.content,
      ...(read.image ? { image: read.image } : {}),
      materializedPath,
    };
  } catch (error) {
    if (isNotFoundError(error)) return { status: 'missing' };
    throw error;
  }
}

async function prepareMaterializationRoot(
  materializationRoot: string,
  workspaceRoots: readonly string[],
): Promise<string> {
  const requestedRoot = path.resolve(materializationRoot);
  await fs.mkdir(requestedRoot, { recursive: true });
  const root = await fs.realpath(requestedRoot);
  for (const workspaceRoot of workspaceRoots) {
    const canonicalWorkspaceRoot =
      await canonicalizePotentialPath(workspaceRoot);
    if (isPathWithin(canonicalWorkspaceRoot, root)) {
      throw new Error(
        'Provider attachment materialization root must be outside every workspace root.',
      );
    }
  }
  return root;
}

async function canonicalizePotentialPath(input: string): Promise<string> {
  let current = path.resolve(input);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.join(existing, ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function providerAttachmentStoragePath(storageRef: string): string {
  if (
    !storageRef.startsWith(PROVIDER_ATTACHMENT_STORAGE_PREFIX) ||
    path.isAbsolute(storageRef) ||
    path.win32.isAbsolute(storageRef) ||
    storageRef.split(/[\\/]/).includes('..')
  ) {
    throw new Error('Invalid provider attachment storage reference.');
  }
  return storageRef.slice(PROVIDER_ATTACHMENT_STORAGE_PREFIX.length);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function readAttachmentContent(
  filePath: string,
  attachment: ReadableAttachmentMetadata,
  extract: DocumentTextExtractor,
): Promise<{ content: string; image?: AttachmentImagePayload }> {
  const textLike = isTextLike(attachment.contentType, attachment.fileName);
  // Dispatch is decided by sniffed bytes first: a conclusive signature
  // overrides metadata; metadata only disambiguates (generic ZIP containers)
  // or fills in when sniffing is inconclusive.
  const sniffedKind = await sniffAttachmentKind(filePath);
  if (
    sniffedKind === 'pdf' ||
    (sniffedKind === 'zip' &&
      isExtractableDocument(attachment.contentType, attachment.fileName)) ||
    (sniffedKind === 'unknown' &&
      isExtractableDocument(attachment.contentType, attachment.fileName))
  ) {
    return { content: await extract(filePath, attachment) };
  }
  if (
    sniffedKind === 'image' ||
    (sniffedKind === 'unknown' &&
      isImageAttachment(attachment.contentType, attachment.fileName))
  ) {
    const label = attachment.fileName || path.basename(filePath);
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_INLINE_IMAGE_BYTES) {
      return {
        content: `ERROR: ${label} is larger than 3 MB, the limit for inline image delivery.`,
      };
    }
    const bytes = await fs.readFile(filePath);
    // Deliver only formats the model APIs accept, typed by the actual bytes:
    // provider metadata is untrusted and a wrong MIME can invalidate the turn.
    const sniffed = sniffDeliverableImageMime(bytes);
    if (!sniffed) {
      return {
        content: `ERROR: ${label} is not in a deliverable image format (PNG, JPEG, GIF, or WebP). Ask for it re-shared in one of those formats.`,
      };
    }
    return {
      content: `ERROR: ${label} is an image. This agent's model cannot view images through this tool. Ask in a conversation with an agent whose model supports image input; vision-capable models read images natively.`,
      image: { base64: bytes.toString('base64'), mimeType: sniffed },
    };
  }
  if (isLegacyOfficeDocument(attachment.fileName)) {
    const label = attachment.fileName || path.basename(filePath);
    return {
      content: `${label} uses a legacy Microsoft Office format that Gantry cannot read yet. Please save it as DOCX, XLSX, PPTX, PDF, RTF, or OpenDocument and share it again.`,
    };
  }
  const limit = textLike ? MAX_TEXT_OUTPUT_BYTES : MAX_BINARY_OUTPUT_BYTES;
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const truncated = bytesRead > limit;
    const content = buffer.subarray(0, Math.min(bytesRead, limit));
    if (textLike) {
      return {
        content: `${content.toString('utf8')}${
          truncated ? '\n\n[Attachment content truncated.]' : ''
        }`,
      };
    }
    const label = attachment.fileName || path.basename(filePath);
    const contentType = attachment.contentType || 'application/octet-stream';
    return {
      content: [
        `${label} (${contentType}), base64 content:`,
        content.toString('base64'),
        ...(truncated ? ['[Attachment content truncated.]'] : []),
      ].join('\n'),
    };
  } finally {
    await file.close();
  }
}

const IMAGE_EXTENSION_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

// Untrusted parsing (officeparser has no abort API; pdfjs uses a fake worker
// on the calling thread in Node) runs in a disposable worker thread with a
// heap cap and an empty environment; the deadline terminates the worker,
// which both cancels the work and deterministically frees the slot.

// createRequire anchored to THIS module resolves the parser packages
// identically from checked-out source and from dist.

// Office documents are zip archives whose central directory declares each
// entry's decompressed size; summing those rejects zip bombs before parsing.

export function truncateTextOutput(text: string): string {
  const content = Buffer.from(text, 'utf8');
  if (content.length <= MAX_TEXT_OUTPUT_BYTES) return text;
  const suffix = '\n\n[Attachment content truncated.]';
  const limit = MAX_TEXT_OUTPUT_BYTES - Buffer.byteLength(suffix, 'utf8');
  return `${content
    .subarray(0, limit)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '')}${suffix}`;
}

function isExtractableDocument(
  contentType?: string,
  fileName?: string,
): boolean {
  const extension = path.extname(fileName ?? '').toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(extension)) return true;
  const normalized = contentType?.toLowerCase() ?? '';
  return (
    normalized === 'application/pdf' ||
    normalized === 'application/rtf' ||
    normalized === 'text/rtf' ||
    normalized.includes('openxmlformats-officedocument') ||
    normalized.includes('opendocument')
  );
}

function isLegacyOfficeDocument(fileName?: string): boolean {
  return LEGACY_OFFICE_EXTENSIONS.has(
    path.extname(fileName ?? '').toLowerCase(),
  );
}

function isImageAttachment(contentType?: string, fileName?: string): boolean {
  const normalized = contentType?.toLowerCase() ?? '';
  if (normalized.startsWith('image/')) return true;
  return /\.(?:png|jpe?g|gif|bmp|tiff?|webp|heic)$/i.test(fileName ?? '');
}

function isTextLike(contentType?: string, fileName?: string): boolean {
  const normalized = contentType?.toLowerCase() ?? '';
  if (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('yaml')
  ) {
    return true;
  }
  return /\.(?:txt|md|csv|json|ya?ml|xml|html?|css|js|ts)$/i.test(
    fileName ?? '',
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
