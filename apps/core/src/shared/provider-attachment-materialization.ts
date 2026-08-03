import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createInboundAttachmentStorageRef,
  writeInboundAttachment,
} from './inbound-attachment-writer.js';

const PROVIDER_ATTACHMENT_STORAGE_PREFIX = 'provider-attachments/';
const MAX_TEXT_OUTPUT_BYTES = 80_000;
const MAX_BINARY_OUTPUT_BYTES = 60_000;
const MAX_DOCUMENT_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_DECOMPRESSED_BYTES = 100 * 1024 * 1024;
const DOCUMENT_PARSE_TIMEOUT_MS = 15_000;
const MAX_PDF_TEXT_PAGES = 50;
const MAX_CONCURRENT_DOCUMENT_PARSES = 2;

// FIFO semaphore for officeparser work. A slot is held until the underlying
// parse SETTLES (not until we stop waiting), so zombie parses stay inside the
// concurrency budget and later requests queue instead of failing.
let availableParseSlots = MAX_CONCURRENT_DOCUMENT_PARSES;
const parseSlotWaiters: Array<() => void> = [];

async function acquireParseSlot(): Promise<() => void> {
  if (availableParseSlots > 0) {
    availableParseSlots -= 1;
  } else {
    await new Promise<void>((resolve) => parseSlotWaiters.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = parseSlotWaiters.shift();
    if (next) next();
    else availableParseSlots += 1;
  };
}
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
        input.extract ?? extractDocumentText,
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
  extract: DocumentTextExtractor,
): Promise<string> {
  const textLike = isTextLike(attachment.contentType, attachment.fileName);
  if (isExtractableDocument(attachment.contentType, attachment.fileName)) {
    return extract(filePath, attachment);
  }
  if (isImageAttachment(attachment.contentType, attachment.fileName)) {
    const label = attachment.fileName || path.basename(filePath);
    return `ERROR: ${label} is an image. This agent's model cannot view images through this tool. Ask in a conversation with an agent whose model supports image input; vision-capable models read images natively.`;
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

export async function extractDocumentText(
  filePath: string,
  attachment: ReadableAttachmentMetadata,
): Promise<string> {
  const label = attachment.fileName || path.basename(filePath);
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_DOCUMENT_INPUT_BYTES) {
    return `ERROR: ${label} is larger than 20 MB, the limit for document text extraction.`;
  }
  const declaredBytes = await declaredZipDecompressedBytes(filePath).catch(
    () => Number.POSITIVE_INFINITY,
  );
  if (declaredBytes > MAX_DOCUMENT_DECOMPRESSED_BYTES) {
    return `ERROR: ${label} could not be verified as a safely sized document (its archive declares too much or unreadable decompressed content), so it was not parsed.`;
  }
  const deadline = Date.now() + DOCUMENT_PARSE_TIMEOUT_MS;
  const officeText = await extractOfficeTextBounded(filePath, deadline);
  if (officeText.length > 0) {
    return truncateTextOutput(officeText);
  }
  if (isPdfAttachment(attachment.contentType, attachment.fileName)) {
    try {
      const text = await extractPdfTextLayer(filePath, deadline);
      if (text.trim().length > 0) {
        return truncateTextOutput(text.trim());
      }
    } catch {
      return `ERROR: ${label} could not be read as a PDF. It may be password-protected, damaged, or use unsupported features.`;
    }
    return `ERROR: ${label} appears to be a scanned or image-only PDF with no text layer. This agent's model cannot view it through this tool; ask an agent whose model supports document/vision input, which reads such PDFs natively.`;
  }
  return `${label} contains no extractable text. It may be encrypted, damaged, or empty.`;
}

async function extractOfficeTextBounded(
  filePath: string,
  deadline: number,
): Promise<string> {
  const release = await acquireParseSlot();
  let parseOffice: typeof import('officeparser').parseOffice;
  try {
    // Heavy parsers load lazily so processes that only route storage refs
    // never pay for them.
    ({ parseOffice } = await import('officeparser'));
  } catch {
    release();
    return '';
  }
  // ponytail: officeparser has no abort API; a timed-out parse keeps its slot
  // (releasing only when it settles) so runaway documents can never exceed
  // MAX_CONCURRENT_DOCUMENT_PARSES. Upgrade path: a resource-limited worker
  // if this shows in production profiles.
  const parse = parseOffice(filePath, {
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
    outputErrorToConsole: false,
  }).then(
    (document) => document.toText().trim(),
    () => '',
  );
  void parse.finally(release);
  return withDeadline(parse, deadline).catch(() => '');
}

// Office documents are zip archives whose central directory declares each
// entry's decompressed size; summing those rejects zip bombs before parsing.
async function declaredZipDecompressedBytes(filePath: string): Promise<number> {
  const file = await fs.open(filePath, 'r');
  try {
    const stats = await file.stat();
    const tailLength = Math.min(stats.size, 66_000);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, stats.size - tailLength);
    const eocd = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (eocd === -1) return 0;
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralSize === 0 || centralSize > 8 * 1024 * 1024) {
      return Number.POSITIVE_INFINITY;
    }
    const central = Buffer.alloc(centralSize);
    await file.read(central, 0, centralSize, centralOffset);
    let cursor = 0;
    let total = 0;
    while (cursor + 46 <= central.length) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) break;
      total += central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return total;
  } finally {
    await file.close();
  }
}

async function extractPdfTextLayer(
  filePath: string,
  deadline: number,
): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  const document = await withDeadline(
    pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    }).promise,
    deadline,
  );
  try {
    const pages = Math.min(document.numPages, MAX_PDF_TEXT_PAGES);
    const parts: string[] = [];
    for (let index = 1; index <= pages; index += 1) {
      const page = await withDeadline(document.getPage(index), deadline);
      const content = await withDeadline(page.getTextContent(), deadline);
      parts.push(
        content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
      );
    }
    const suffix =
      document.numPages > pages
        ? `\n\n[Text extracted from the first ${pages} of ${document.numPages} pages.]`
        : '';
    return parts.join('\n') + suffix;
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

async function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('document parse deadline exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, rejectRace) => {
        timer = setTimeout(
          () => rejectRace(new Error('document parse deadline exceeded')),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function truncateTextOutput(text: string): string {
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
