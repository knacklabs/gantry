import fs from 'node:fs/promises';
import path from 'node:path';

import { parseOffice } from 'officeparser';

import {
  extractAttachmentOcrText,
  isOcrImageAttachment,
} from './provider-attachment-ocr.js';
import {
  createInboundAttachmentStorageRef,
  writeInboundAttachment,
} from './inbound-attachment-writer.js';

const PROVIDER_ATTACHMENT_STORAGE_PREFIX = 'provider-attachments/';
const MAX_TEXT_OUTPUT_BYTES = 80_000;
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

type AttachmentOcr = typeof extractAttachmentOcrText;

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
  ocr?: AttachmentOcr;
}): Promise<
  | { status: 'opened'; content: string; materializedPath: string }
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
    return {
      status: 'opened',
      content: await readAttachmentContent(
        materializedPath,
        input.attachment,
        input.ocr ?? extractAttachmentOcrText,
      ),
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
  ocr: AttachmentOcr,
): Promise<string> {
  const textLike = isTextLike(attachment.contentType, attachment.fileName);
  if (isExtractableDocument(attachment.contentType, attachment.fileName)) {
    return extractDocumentText(filePath, attachment, ocr);
  }
  if (isOcrImageAttachment(attachment.contentType, attachment.fileName)) {
    return extractOcrText(filePath, attachment, ocr);
  }
  if (isLegacyOfficeDocument(attachment.fileName)) {
    const label = attachment.fileName || path.basename(filePath);
    return `${label} uses a legacy Microsoft Office format that Gantry cannot read yet. Please save it as DOCX, XLSX, PPTX, PDF, RTF, or OpenDocument and share it again.`;
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
      return `${content.toString('utf8')}${
        truncated ? '\n\n[Attachment content truncated.]' : ''
      }`;
    }
    const label = attachment.fileName || path.basename(filePath);
    const contentType = attachment.contentType || 'application/octet-stream';
    return [
      `${label} (${contentType}), base64 content:`,
      content.toString('base64'),
      ...(truncated ? ['[Attachment content truncated.]'] : []),
    ].join('\n');
  } finally {
    await file.close();
  }
}

async function extractDocumentText(
  filePath: string,
  attachment: ReadableAttachmentMetadata,
  ocr: AttachmentOcr,
): Promise<string> {
  const label = attachment.fileName || path.basename(filePath);
  try {
    const document = await parseOffice(filePath, {
      extractAttachments: false,
      includeRawContent: false,
      ocr: false,
      outputErrorToConsole: false,
    });
    const text = document.toText().trim();
    if (text.length >= 24) {
      return truncateTextOutput(text);
    }
  } catch {
    // Scanned PDFs commonly fail or return no text in the direct parser. OCR is
    // intentionally attempted only after this fast path has failed.
  }
  if (isPdfAttachment(attachment.contentType, attachment.fileName)) {
    return extractOcrText(filePath, attachment, ocr);
  }
  return `${label} contains no extractable text. It may be image-only, encrypted, damaged, or empty.`;
}

async function extractOcrText(
  filePath: string,
  attachment: ReadableAttachmentMetadata,
  ocr: AttachmentOcr,
): Promise<string> {
  const label = attachment.fileName || path.basename(filePath);
  try {
    const text = (
      await ocr({
        filePath,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
      })
    ).trim();
    return text
      ? truncateTextOutput(text)
      : `Gantry OCR found no readable text in ${label}.`;
  } catch {
    return `Gantry could not extract text from ${label}. The file may be damaged, encrypted, too large, or use unsupported image features.`;
  }
}

function truncateTextOutput(text: string): string {
  const content = Buffer.from(text, 'utf8');
  if (content.length <= MAX_TEXT_OUTPUT_BYTES) return text;
  return `${content.subarray(0, MAX_TEXT_OUTPUT_BYTES).toString('utf8')}\n\n[Attachment content truncated.]`;
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

function isPdfAttachment(contentType?: string, fileName?: string): boolean {
  return (
    path.extname(fileName ?? '').toLowerCase() === '.pdf' ||
    contentType?.toLowerCase() === 'application/pdf'
  );
}

function isLegacyOfficeDocument(fileName?: string): boolean {
  return LEGACY_OFFICE_EXTENSIONS.has(
    path.extname(fileName ?? '').toLowerCase(),
  );
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
