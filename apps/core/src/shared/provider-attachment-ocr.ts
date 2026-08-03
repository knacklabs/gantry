import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, type Worker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const englishLanguageData = require('@tesseract.js-data/eng') as {
  code: string;
  gzip: boolean;
  langPath: string;
};

const OCR_WORKER_COUNT = 2;
const OCR_JOB_TIMEOUT_MS = 25_000;
const OCR_IDLE_TERMINATION_MS = 60_000;
const PDF_OCR_MAX_PAGES = 4;
const PDF_RENDER_SCALE = 1.75;
const MAX_OCR_INPUT_BYTES = 20 * 1024 * 1024;

type OcrImage = Parameters<Worker['recognize']>[0];

interface OcrJob {
  image: OcrImage;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

interface OcrWorkerSlot {
  busy: boolean;
  worker?: Promise<Worker>;
}

const workerSlots: OcrWorkerSlot[] = Array.from(
  { length: OCR_WORKER_COUNT },
  () => ({ busy: false }),
);
const pendingJobs: OcrJob[] = [];
let idleTerminationTimer: NodeJS.Timeout | undefined;

export function isOcrImageAttachment(
  contentType?: string,
  fileName?: string,
): boolean {
  const normalized = contentType?.toLowerCase() ?? '';
  if (normalized.startsWith('image/') && normalized !== 'image/svg+xml') {
    return true;
  }
  return /\.(?:bmp|gif|jpe?g|png|tiff?|webp)$/i.test(fileName ?? '');
}

export async function extractAttachmentOcrText(input: {
  filePath: string;
  fileName?: string;
  contentType?: string;
}): Promise<string> {
  const stat = await fs.stat(input.filePath);
  if (stat.size > MAX_OCR_INPUT_BYTES) {
    throw new Error('attachment is too large for bounded OCR');
  }
  const extension = path
    .extname(input.fileName ?? input.filePath)
    .toLowerCase();
  if (
    extension === '.pdf' ||
    input.contentType?.toLowerCase() === 'application/pdf'
  ) {
    return ocrPdf(input.filePath);
  }
  if (isOcrImageAttachment(input.contentType, input.fileName)) {
    return recognizeWithPool(input.filePath);
  }
  throw new Error('attachment type is not supported by OCR');
}

export async function terminateAttachmentOcrWorkers(): Promise<void> {
  if (idleTerminationTimer) clearTimeout(idleTerminationTimer);
  idleTerminationTimer = undefined;
  await Promise.all(
    workerSlots.map(async (slot) => {
      const worker = slot.worker;
      slot.worker = undefined;
      if (!worker) return;
      await worker.then((value) => value.terminate()).catch(() => undefined);
    }),
  );
}

async function ocrPdf(filePath: string): Promise<string> {
  const data = new Uint8Array(await fs.readFile(filePath));
  const loadingTask = getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  try {
    const pdf = await loadingTask.promise;
    const pageCount = Math.min(pdf.numPages, PDF_OCR_MAX_PAGES);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport,
      }).promise;
      const text = (await recognizeWithPool(await canvas.encode('png'))).trim();
      if (text) pages.push(`[Page ${pageNumber}]\n${text}`);
      page.cleanup();
    }
    if (pdf.numPages > pageCount) {
      pages.push(
        `[OCR limited to the first ${pageCount} of ${pdf.numPages} pages to keep processing bounded.]`,
      );
    }
    return pages.join('\n\n').trim();
  } finally {
    await loadingTask.destroy();
  }
}

function recognizeWithPool(image: OcrImage): Promise<string> {
  if (idleTerminationTimer) clearTimeout(idleTerminationTimer);
  idleTerminationTimer = undefined;
  return new Promise<string>((resolve, reject) => {
    pendingJobs.push({ image, resolve, reject });
    drainOcrQueue();
  });
}

function drainOcrQueue(): void {
  for (const slot of workerSlots) {
    if (slot.busy) continue;
    const job = pendingJobs.shift();
    if (!job) break;
    slot.busy = true;
    void runOcrJob(slot, job);
  }
  scheduleIdleTermination();
}

async function runOcrJob(slot: OcrWorkerSlot, job: OcrJob): Promise<void> {
  try {
    const worker = await getOcrWorker(slot);
    const result = await withTimeout(worker.recognize(job.image));
    job.resolve(result.data.text);
  } catch (error) {
    const worker = slot.worker;
    slot.worker = undefined;
    if (worker) {
      void worker.then((value) => value.terminate()).catch(() => undefined);
    }
    job.reject(error);
  } finally {
    slot.busy = false;
    drainOcrQueue();
  }
}

function getOcrWorker(slot: OcrWorkerSlot): Promise<Worker> {
  slot.worker ??= createWorker(englishLanguageData.code, 1, {
    cachePath: path.join(os.tmpdir(), 'gantry-tesseract-cache'),
    gzip: englishLanguageData.gzip,
    langPath: englishLanguageData.langPath,
    logger: () => undefined,
  });
  return slot.worker;
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('OCR processing timed out')),
          OCR_JOB_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scheduleIdleTermination(): void {
  if (
    idleTerminationTimer ||
    pendingJobs.length > 0 ||
    workerSlots.some((slot) => slot.busy)
  ) {
    return;
  }
  idleTerminationTimer = setTimeout(() => {
    idleTerminationTimer = undefined;
    void terminateAttachmentOcrWorkers();
  }, OCR_IDLE_TERMINATION_MS);
  idleTerminationTimer.unref();
}
