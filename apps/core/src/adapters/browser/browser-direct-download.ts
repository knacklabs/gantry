import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from 'playwright-core';

import { nowMs } from '../../shared/time/datetime.js';
import { resolveBrowserOutputPath } from './browser-artifact-policy.js';
import { browserFileReferenceResult } from './browser-result-hygiene.js';

const MAX_BROWSER_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export async function captureBrowserDownload(input: {
  locator: Locator;
  page: Page;
  outputDir: string;
  requestedFilename?: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const requestedPath = input.requestedFilename
    ? resolveBrowserOutputPath(input.requestedFilename, input.outputDir)
    : undefined;
  const downloadPromise = input.page.waitForEvent('download', {
    timeout: input.timeoutMs,
  });
  await input.locator.click({ timeout: input.timeoutMs });
  const download = await downloadPromise;
  const failure = await download.failure();
  if (failure) throw new Error(`Browser download failed: ${failure}`);

  const suggestedName = safeDownloadFilename(download.suggestedFilename());
  const filename =
    requestedPath ??
    resolveBrowserOutputPath(
      path.join('downloads', `${nowMs()}-${suggestedName}`),
      input.outputDir,
    );
  await download.saveAs(filename);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_BROWSER_DOWNLOAD_BYTES) {
    fs.rmSync(filename, { force: true });
    throw new Error(
      `Browser downloads are limited to ${MAX_BROWSER_DOWNLOAD_BYTES} bytes.`,
    );
  }
  return browserFileReferenceResult(filename, stat);
}

function safeDownloadFilename(value: string): string {
  const filename = path
    .basename(value.trim())
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180);
  if (!filename || filename === '.' || filename === '..') {
    return 'download.bin';
  }
  return filename;
}
