import fs from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_TEXT_OUTPUT_BYTES,
  truncateTextOutput,
} from './provider-attachment-materialization.js';

interface ReadableAttachmentMetadata {
  fileName?: string;
  contentType?: string;
}

const MAX_DOCUMENT_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_DECOMPRESSED_BYTES = 100 * 1024 * 1024;
const DOCUMENT_PARSE_TIMEOUT_MS = 15_000;
const MAX_PDF_TEXT_PAGES = 50;
const MAX_CONCURRENT_DOCUMENT_PARSES = 2;

// FIFO semaphore bounding concurrent document parsing. Acquire honors the
// caller's deadline and returns null when the wait exceeds it, so queue time
// can never exceed the extraction budget.
let availableParseSlots = MAX_CONCURRENT_DOCUMENT_PARSES;
const parseSlotWaiters: Array<(slot: boolean) => void> = [];

async function acquireParseSlot(
  deadline: number,
): Promise<(() => void) | null> {
  if (availableParseSlots > 0) {
    availableParseSlots -= 1;
  } else {
    const granted = await new Promise<boolean>((resolve) => {
      const waiter = (slot: boolean) => {
        clearTimeout(timer);
        resolve(slot);
      };
      const timer = setTimeout(
        () => {
          const index = parseSlotWaiters.indexOf(waiter);
          if (index !== -1) parseSlotWaiters.splice(index, 1);
          resolve(false);
        },
        Math.max(0, deadline - Date.now()),
      );
      parseSlotWaiters.push(waiter);
    });
    if (!granted) return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = parseSlotWaiters.shift();
    if (next) next(true);
    else availableParseSlots += 1;
  };
}

async function hasPdfHeader(filePath: string): Promise<boolean> {
  const file = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, 8, 0);
    return (
      bytesRead >= 5 && header.subarray(0, 5).toString('latin1') === '%PDF-'
    );
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
  const deadline = Date.now() + DOCUMENT_PARSE_TIMEOUT_MS;
  // Route on the file's actual bytes, not provider-controlled metadata:
  // officeparser auto-detects content, so metadata-based routing would let a
  // mislabeled file skip the matching resource guard.
  const isPdf = await hasPdfHeader(filePath);
  const declaredBytes = isPdf
    ? null
    : await declaredZipDecompressedBytes(filePath).catch(
        () => Number.POSITIVE_INFINITY,
      );
  if (isPdf) {
    // PDF pages are parsed in the terminable worker with a hard page cap.
    const release = await acquireParseSlot(deadline);
    if (!release) {
      return `ERROR: document extraction is busy; ${label} was not read. Retry in a moment.`;
    }
    try {
      const text = (
        await parseInWorker('pdf', filePath, deadline, { rethrow: true })
      ).trim();
      if (text.length > 0) return truncateTextOutput(text);
      return `ERROR: ${label} appears to be a scanned or image-only PDF with no text layer, which this tool cannot deliver. Ask for a text-based export, or ask the sender to share the pages as images so a vision-capable agent can view them.`;
    } catch {
      return `ERROR: ${label} could not be read as a PDF. It may be password-protected, damaged, or use unsupported features.`;
    } finally {
      release();
    }
  }
  if (
    declaredBytes !== null &&
    declaredBytes > MAX_DOCUMENT_DECOMPRESSED_BYTES
  ) {
    return `ERROR: ${label} could not be verified as a safely sized document (its archive declares too much or unreadable decompressed content), so it was not parsed.`;
  }
  const release = await acquireParseSlot(deadline);
  if (!release) {
    return `ERROR: document extraction is busy; ${label} was not read. Retry in a moment.`;
  }
  try {
    const text = (await parseInWorker('office', filePath, deadline)).trim();
    if (text.length > 0) return truncateTextOutput(text);
    return `${label} contains no extractable text. It may be encrypted, damaged, or empty.`;
  } finally {
    release();
  }
}

async function parseInWorker(
  kind: 'office' | 'pdf',
  filePath: string,
  deadline: number,
  options?: { rethrow?: boolean },
): Promise<string> {
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(DOCUMENT_PARSE_WORKER_SOURCE, {
    eval: true,
    env: {},
    resourceLimits: {
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: 64,
    },
    workerData: {
      kind,
      filePath,
      parentUrl: import.meta.url,
      maxPdfPages: MAX_PDF_TEXT_PAGES,
      // Bounded inside the worker BEFORE postMessage so an adversarial
      // document can never clone an unbounded string into the host heap.
      maxOutputChars: MAX_TEXT_OUTPUT_BYTES,
    },
  });
  try {
    const parsed = withDeadline(
      new Promise<string>((resolve, reject) => {
        worker.once('message', (message: { text?: string; error?: string }) =>
          typeof message.text === 'string'
            ? resolve(message.text)
            : reject(new Error(message.error ?? 'parse failed')),
        );
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`parser worker exited ${code}`));
        });
      }),
      deadline,
    );
    return options?.rethrow ? await parsed : await parsed.catch(() => '');
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

async function declaredZipDecompressedBytes(
  filePath: string,
): Promise<number | null> {
  const file = await fs.open(filePath, 'r');
  try {
    const stats = await file.stat();
    const tailLength = Math.min(stats.size, 66_000);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, stats.size - tailLength);
    const eocd = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (eocd === -1) return null;
    if (eocd + 22 > tail.length) return Number.POSITIVE_INFINITY;
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralSize === 0 || centralSize > 8 * 1024 * 1024) {
      return Number.POSITIVE_INFINITY;
    }
    if (centralOffset + centralSize > stats.size) {
      return Number.POSITIVE_INFINITY;
    }
    const central = Buffer.alloc(centralSize);
    await file.read(central, 0, centralSize, centralOffset);
    let cursor = 0;
    let total = 0;
    let records = 0;
    while (cursor + 46 <= central.length) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) break;
      total += central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      cursor += 46 + nameLength + extraLength + commentLength;
      records += 1;
    }
    // The directory must be fully consumed and agree with the EOCD entry
    // count; a partially valid directory is how a bomb hides from this scan
    // while the parser (which follows the EOCD count) still expands it.
    if (records !== entryCount || cursor !== central.length) {
      return Number.POSITIVE_INFINITY;
    }
    return total;
  } finally {
    await file.close();
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

const DOCUMENT_PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const parentRequire = createRequire(workerData.parentUrl);
const TRUNCATION_MARK = '\\n\\n[Attachment content truncated.]';
const clamp = (text) =>
  text.length > workerData.maxOutputChars
    ? text.slice(0, workerData.maxOutputChars - TRUNCATION_MARK.length) +
      TRUNCATION_MARK
    : text;
const report = (result) =>
  parentPort.postMessage(
    typeof result.text === 'string' ? { text: clamp(result.text) } : result,
  );
const fail = (error) => report({ error: String(error && error.message) });
if (workerData.kind === 'office') {
  const { parseOffice } = parentRequire('officeparser');
  parseOffice(workerData.filePath, {
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
    outputErrorToConsole: false,
  })
    .then((document) => report({ text: document.toText() }))
    .catch(fail);
} else {
  const fs = require('node:fs/promises');
  const pdfPath = parentRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  (async () => {
    const pdfjs = await import(pathToFileURL(pdfPath).href);
    const data = new Uint8Array(await fs.readFile(workerData.filePath));
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    });
    const document = await task.promise;
    const pages = Math.min(document.numPages, workerData.maxPdfPages);
    const parts = [];
    let collected = 0;
    for (let index = 1; index <= pages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      parts.push(pageText.slice(0, workerData.maxOutputChars - collected));
      collected += pageText.length;
      if (collected >= workerData.maxOutputChars) break;
    }
    const suffix =
      document.numPages > pages
        ? '\\n\\n[Text extracted from the first ' +
          pages +
          ' of ' +
          document.numPages +
          ' pages.]'
        : '';
    report({ text: parts.join('\\n') + suffix });
  })().catch(fail);
}
`;

export async function sniffAttachmentKind(
  filePath: string,
): Promise<'document' | 'image' | 'unknown'> {
  const file = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, 12, 0);
    if (
      bytesRead >= 5 &&
      header.subarray(0, 5).toString('latin1') === '%PDF-'
    ) {
      return 'document';
    }
    if (bytesRead >= 4 && header.readUInt32LE(0) === 0x04034b50) {
      return 'document';
    }
    if (sniffDeliverableImageMime(header.subarray(0, bytesRead))) {
      return 'image';
    }
    return 'unknown';
  } finally {
    await file.close();
  }
}

export function sniffDeliverableImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
