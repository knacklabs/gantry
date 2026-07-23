import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
import { type Browser, type Page } from 'playwright-core';
import type { Locator } from 'playwright-core';

import { ensureBrowserArtifactRoot } from './browser-artifact-policy.js';
import {
  resolveTargetLocator,
  snapshotPage,
  takeScreenshot,
} from './browser-direct-page-actions.js';
import {
  formFields,
  normalizeBrowserDirectPayload,
} from './browser-direct-payload.js';
import {
  allPages,
  closeBrowserDirectConnections,
  closeCachedConnection,
  firstContext,
  getBrowserConnection,
  observePage,
  pageState,
  safeTitle,
  scheduleConnectionIdleClose,
  type BrowserConnection,
} from './browser-direct-session.js';
import {
  isInternalChromeTarget,
  normalizeBrowserToolResult,
  textResult,
  writeOptionalTextOutput,
} from './browser-result-hygiene.js';
import {
  clearBrowserTabIndexMappings,
  projectBrowserTabsResult,
  translateBrowserTabsInput,
} from './browser-tabs.js';
import {
  browserClickModifiers,
  stringRecord,
} from './browser-direct-values.js';
import {
  actionOperationTimeout,
  browserActionTimeoutMs,
  BROWSER_ACTION_TIMEOUT_MS,
  remainingBrowserActionTimeoutMs,
  withTimeout,
} from './browser-direct-timeout.js';
import { nowMs } from '../../shared/time/datetime.js';

export { BROWSER_ACTION_TIMEOUT_MS };
export {
  normalizeBrowserToolResult,
  sanitizeBrowserTabsResult,
} from './browser-result-hygiene.js';

interface BrowserToolSession {
  running?: boolean;
  cdpReady?: boolean;
  port?: number;
  profileName?: string;
}

const selectedBackendIndexBySession = new Map<string, number>();
export async function callBrowserTool(input: {
  toolName: BrowserBackendAction;
  arguments: Record<string, unknown>;
  session: BrowserToolSession;
  fileAccessRoot: string;
  timeoutMs?: number;
}): Promise<unknown> {
  if (
    !input.session.running ||
    !input.session.cdpReady ||
    !input.session.port
  ) {
    throw new Error('Browser is not ready for actions.');
  }

  const outputDir = ensureBrowserArtifactRoot(input.fileAccessRoot);
  const actionTimeoutMs = browserActionTimeoutMs(input.timeoutMs);
  const deadline = nowMs() + actionTimeoutMs;
  const cdpEndpoint = `http://127.0.0.1:${input.session.port}`;
  const sessionKey = `${input.session.profileName || 'default'}\0${cdpEndpoint}`;
  const connection = await getBrowserConnection({
    key: backendKey(input.session.profileName, cdpEndpoint),
    cdpEndpoint,
    deadline,
    remainingMs: remainingBrowserActionTimeoutMs,
    withTimeout,
  });

  try {
    const args = normalizeBrowserDirectPayload(
      input.toolName,
      input.arguments,
      {
        fileAccessRoot: outputDir,
      },
    );
    const translatedArgs = translateBrowserTabsInput(
      input.toolName,
      args,
      sessionKey,
    );
    const result = await dispatchBrowserToolWithReconnect({
      connection,
      sessionKey,
      cdpEndpoint,
      toolName: input.toolName,
      args: translatedArgs,
      outputDir,
      deadline,
    });
    return normalizeBrowserToolResult(input.toolName, translatedArgs, result, {
      artifactRoot: outputDir,
      tabSessionKey: sessionKey,
    });
  } catch (err) {
    await closeCachedConnection(connection.key);
    if (shouldReturnSnapshotAfterNavigateBackTimeout(input.toolName, err)) {
      return await callBrowserTool({
        ...input,
        toolName: 'snapshot',
        arguments: {},
      });
    }
    throw new Error(formatBackendError(input.toolName, err), { cause: err });
  } finally {
    scheduleConnectionIdleClose(connection.key);
  }
}

async function dispatchBrowserToolWithReconnect(input: {
  connection: BrowserConnection;
  sessionKey: string;
  cdpEndpoint: string;
  toolName: BrowserBackendAction;
  args: Record<string, unknown>;
  outputDir: string;
  deadline: number;
}): Promise<unknown> {
  try {
    return await dispatchBrowserTool(input);
  } catch (err) {
    if (!isStaleBrowserError(err)) throw err;
  }
  await closeCachedConnection(input.connection.key);
  const connection = await getBrowserConnection({
    key: input.connection.key,
    cdpEndpoint: input.cdpEndpoint,
    deadline: input.deadline,
    remainingMs: remainingBrowserActionTimeoutMs,
    withTimeout,
  });
  return await dispatchBrowserTool({ ...input, connection });
}

async function dispatchBrowserTool(input: {
  connection: BrowserConnection;
  sessionKey: string;
  cdpEndpoint: string;
  toolName: BrowserBackendAction;
  args: Record<string, unknown>;
  outputDir: string;
  deadline: number;
}): Promise<unknown> {
  return await withTimeout(
    dispatchBrowserToolInner(input),
    remainingBrowserActionTimeoutMs(input.deadline),
    `Browser backend timed out while running ${input.toolName}.`,
  );
}

async function dispatchBrowserToolInner(input: {
  connection: BrowserConnection;
  sessionKey: string;
  toolName: BrowserBackendAction;
  args: Record<string, unknown>;
  outputDir: string;
  deadline: number;
}): Promise<unknown> {
  switch (input.toolName) {
    case 'tabs':
      return await runBrowserTabs(input);
    case 'navigate':
      return await runWithActivePage(input, async (page) => {
        const url = requiredString(input.args.url, 'navigate.url');
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: actionOperationTimeout(input.deadline),
        });
        return textResult(
          `Navigated to ${page.url()}${response ? ` (${response.status()})` : ''}.`,
        );
      });
    case 'back':
      return await runWithActivePage(input, async (page) => {
        await page.goBack({
          waitUntil: 'commit',
          timeout: actionOperationTimeout(input.deadline),
        });
        return textResult(`Navigated back to ${page.url()}.`);
      });
    case 'snapshot':
      return await runWithActivePage(input, async (page) =>
        writeOptionalTextOutput(
          await snapshotPage(page, input.args),
          input.args,
        ),
      );
    case 'screenshot':
      return await runWithActivePage(input, async (page) =>
        takeScreenshot(page, input.args, input.outputDir),
      );
    case 'console_messages':
      return await runWithActivePage(input, async (page) =>
        writeOptionalTextOutput(
          JSON.stringify(pageState(page).console, null, 2),
          input.args,
        ),
      );
    case 'network_requests':
      return await runWithActivePage(input, async (page) =>
        writeOptionalTextOutput(
          JSON.stringify(pageState(page).network, null, 2),
          input.args,
        ),
      );
    case 'click':
      return await runWithTarget(input, async (locator) => {
        const button = stringValue(input.args.button) as
          'left' | 'right' | 'middle' | undefined;
        const modifiers = browserClickModifiers(input.args.modifiers);
        await locator.click({
          button: button ?? 'left',
          clickCount: input.args.doubleClick === true ? 2 : 1,
          ...(modifiers.length > 0 ? { modifiers } : {}),
          timeout: actionOperationTimeout(input.deadline),
        });
        return textResult('Clicked element.');
      });
    case 'hover':
      return await runWithTarget(input, async (locator) => {
        await locator.hover({
          timeout: actionOperationTimeout(input.deadline),
        });
        return textResult('Hovered element.');
      });
    case 'type':
      return await runWithTarget(input, async (locator, page) => {
        await locator.click({
          timeout: actionOperationTimeout(input.deadline),
        });
        await page.keyboard.type(requiredString(input.args.text, 'text'), {
          delay: input.args.slowly === true ? 80 : 0,
        });
        if (input.args.submit === true) await page.keyboard.press('Enter');
        return textResult('Typed text.');
      });
    case 'press_key':
      return await runWithActivePage(input, async (page) => {
        await page.keyboard.press(requiredString(input.args.key, 'key'));
        return textResult('Pressed key.');
      });
    case 'drag':
      return await runWithActivePage(input, async (page) => {
        const start = await resolveTargetLocator(
          page,
          requiredString(input.args.startTarget, 'startTarget'),
        );
        const end = await resolveTargetLocator(
          page,
          requiredString(input.args.endTarget, 'endTarget'),
        );
        await start.dragTo(end, {
          timeout: actionOperationTimeout(input.deadline),
        });
        return textResult('Dragged element.');
      });
    case 'drop':
      return await runWithTarget(input, async (locator) => {
        const paths = arrayOfStrings(input.args.paths);
        if (paths.length > 0) {
          throw new Error('drop does not accept filesystem paths.');
        }
        const data = stringRecord(input.args.data);
        if (Object.keys(data).length === 0) {
          throw new Error('drop requires data.');
        }
        await locator.evaluate((element, payload) => {
          const transfer = new (globalThis as any).DataTransfer();
          for (const [type, value] of Object.entries(payload)) {
            transfer.setData(type, value);
          }
          element.dispatchEvent(
            new (globalThis as any).DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        }, data);
        return textResult('Dropped data.');
      });
    case 'select_option':
      return await runWithTarget(input, async (locator) => {
        await locator.selectOption(arrayOfStrings(input.args.values), {
          timeout: actionOperationTimeout(input.deadline),
        });
        return textResult('Selected option.');
      });
    case 'fill_form':
      return await runWithActivePage(input, async (page) => {
        for (const field of formFields(input.args.fields)) {
          const locator = await resolveTargetLocator(page, field.target);
          if (field.type === 'checkbox' || field.type === 'radio') {
            const checked = field.value === 'true';
            if (checked) {
              await locator.check({
                timeout: actionOperationTimeout(input.deadline),
              });
            } else {
              await locator.uncheck({
                timeout: actionOperationTimeout(input.deadline),
              });
            }
          } else if (field.type === 'combobox') {
            await locator.selectOption(field.value, {
              timeout: actionOperationTimeout(input.deadline),
            });
          } else {
            await locator.fill(field.value, {
              timeout: actionOperationTimeout(input.deadline),
            });
          }
        }
        return textResult('Filled form.');
      });
    case 'wait_for':
      return await runWithActivePage(input, async (page) => {
        const time = toOptionalPositiveNumber(input.args.time);
        const text = stringValue(input.args.text);
        const textGone = stringValue(input.args.textGone);
        if (time !== undefined) await page.waitForTimeout(time * 1000);
        if (text) {
          await page
            .getByText(text)
            .first()
            .waitFor({ timeout: actionOperationTimeout(input.deadline) });
        }
        if (textGone) {
          await page
            .getByText(textGone)
            .first()
            .waitFor({
              state: 'hidden',
              timeout: actionOperationTimeout(input.deadline),
            });
        }
        return textResult('Wait completed.');
      });
    case 'evaluate':
      return await runWithActivePage(input, async (page) => {
        const source = requiredString(input.args.function, 'function');
        const target = stringValue(input.args.target);
        const value = target
          ? await (
              await resolveTargetLocator(page, target)
            ).evaluate((element, fnSource) => {
              const fn = new Function(
                'element',
                `return (${fnSource})(element);`,
              );
              return fn(element);
            }, source)
          : await page.evaluate((fnSource) => {
              const fn = new Function(`return (${fnSource})();`);
              return fn();
            }, source);
        return writeOptionalTextOutput(
          JSON.stringify(value, null, 2),
          input.args,
        );
      });
    case 'file_upload':
    case 'file_attach':
      return await runWithActivePage(input, async (page) => {
        const paths = arrayOfStrings(input.args.paths);
        if (paths.length === 0) {
          throw new Error(`${input.toolName} requires at least one path.`);
        }
        const target = stringValue(input.args.target);
        if (target) {
          await (
            await resolveTargetLocator(page, target)
          ).setInputFiles(paths, {
            timeout: actionOperationTimeout(input.deadline),
          });
        } else {
          await page.setInputFiles('input[type=file]', paths, {
            timeout: actionOperationTimeout(input.deadline),
          });
        }
        return textResult(`Uploaded ${paths.length} file(s).`);
      });
    case 'handle_dialog':
      return await runWithActivePage(input, async (page) => {
        const accept = input.args.accept !== false;
        const promptText = stringValue(input.args.promptText);
        page.once('dialog', (dialog) => {
          if (accept) void dialog.accept(promptText).catch(() => undefined);
          else void dialog.dismiss().catch(() => undefined);
        });
        return textResult('Dialog handler armed for the next dialog.');
      });
    case 'resize':
      return await runWithActivePage(input, async (page) => {
        const width = requiredPositiveInteger(input.args.width, 'width');
        const height = requiredPositiveInteger(input.args.height, 'height');
        await page.setViewportSize({ width, height });
        return textResult(`Browser viewport resized to ${width}x${height}.`);
      });
    default:
      throw new Error(`Unsupported browser action: ${input.toolName}`);
  }
}

async function runWithTarget(
  input: {
    connection: BrowserConnection;
    sessionKey: string;
    toolName: BrowserBackendAction;
    args: Record<string, unknown>;
    deadline: number;
  },
  fn: (locator: Locator, page: Page) => Promise<unknown>,
): Promise<unknown> {
  return await runWithActivePage(input, async (page) =>
    fn(
      await resolveTargetLocator(
        page,
        requiredString(input.args.target, 'target'),
      ),
      page,
    ),
  );
}

async function runWithActivePage<T>(
  input: {
    connection: BrowserConnection;
    sessionKey: string;
    toolName: BrowserBackendAction;
    deadline: number;
  },
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await activePage(input.connection.browser, input.sessionKey);
  observePage(page);
  await page.bringToFront().catch(() => undefined);
  return await fn(page);
}

async function runBrowserTabs(input: {
  connection: BrowserConnection;
  sessionKey: string;
  toolName: BrowserBackendAction;
  args: Record<string, unknown>;
  deadline: number;
}): Promise<unknown> {
  const action = stringValue(input.args.action) || 'list';
  const pages = await allPages(input.connection.browser);
  switch (action) {
    case 'list':
      return await tabsResult(pages, input.sessionKey);
    case 'select': {
      const index = requiredPositiveInteger(input.args.index, 'index', {
        allowZero: true,
      });
      const page = pages[index];
      if (!page || isInternalChromeTarget(page.url(), await safeTitle(page))) {
        throw new Error('Browser tab select target is not available.');
      }
      selectedBackendIndexBySession.set(input.sessionKey, index);
      await page.bringToFront().catch(() => undefined);
      return await tabsResult(pages, input.sessionKey);
    }
    case 'close': {
      const index = requiredPositiveInteger(input.args.index, 'index', {
        allowZero: true,
      });
      const page = pages[index];
      if (!page || isInternalChromeTarget(page.url(), await safeTitle(page))) {
        throw new Error('Browser tab close target is not available.');
      }
      await page.close();
      selectedBackendIndexBySession.delete(input.sessionKey);
      return await tabsResult(
        await allPages(input.connection.browser),
        input.sessionKey,
      );
    }
    case 'new': {
      const context = firstContext(input.connection.browser);
      const page = await context.newPage();
      observePage(page);
      selectedBackendIndexBySession.set(
        input.sessionKey,
        (await allPages(input.connection.browser)).indexOf(page),
      );
      const url = stringValue(input.args.url);
      if (url) {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: actionOperationTimeout(input.deadline),
        });
      }
      return await tabsResult(
        await allPages(input.connection.browser),
        input.sessionKey,
      );
    }
    default:
      throw new Error(`Unsupported tabs action: ${action}`);
  }
}

async function tabsResult(pages: Page[], sessionKey: string): Promise<unknown> {
  const selected = selectedBackendIndexBySession.get(sessionKey);
  const tabs = await Promise.all(
    pages.map(async (page, index) => ({
      index,
      title: await safeTitle(page),
      url: page.url(),
      current: selected === undefined ? index === 0 : selected === index,
    })),
  );
  return projectBrowserTabsResult(
    {
      content: [
        {
          type: 'text',
          text: tabs
            .filter((tab) => !isInternalChromeTarget(tab.url, tab.title))
            .map(
              (tab) =>
                `- ${tab.index}: ${tab.current ? '(current) ' : ''}${tab.title || '(untitled)'} ${tab.url}`,
            )
            .join('\n'),
        },
      ],
      structuredContent: { tabs },
    },
    sessionKey,
    'tabs',
    { action: 'list' },
  );
}

async function activePage(browser: Browser, sessionKey: string): Promise<Page> {
  const pages = await allPages(browser);
  const selected = selectedBackendIndexBySession.get(sessionKey);
  const selectedPage = selected !== undefined ? pages[selected] : undefined;
  if (
    selectedPage &&
    !isInternalChromeTarget(selectedPage.url(), await safeTitle(selectedPage))
  ) {
    return selectedPage;
  }
  for (const page of pages) {
    if (!isInternalChromeTarget(page.url(), await safeTitle(page))) {
      return page;
    }
  }
  const context = firstContext(browser);
  const page = await context.newPage();
  observePage(page);
  return page;
}

export async function closeBrowserToolBackends(
  profileName?: string,
): Promise<void> {
  await closeBrowserDirectConnections(profileName);
  clearBrowserTabIndexMappings(profileName);
  for (const key of [...selectedBackendIndexBySession.keys()]) {
    if (!profileName || key.startsWith(`${profileName}\0`)) {
      selectedBackendIndexBySession.delete(key);
    }
  }
}

function backendKey(profileName: string | undefined, cdpEndpoint: string) {
  return `${profileName || 'default'}\0${cdpEndpoint}`;
}

function formatBackendError(toolName: string, err: unknown): string {
  const message = errorMessage(err);
  if (/timed? out|timeout/i.test(message)) {
    return `Browser backend timeout while running ${toolName}: ${message}`;
  }
  return `Browser backend failed while running ${toolName}: ${message}`;
}

export { formatBackendError };

function shouldReturnSnapshotAfterNavigateBackTimeout(
  toolName: BrowserBackendAction,
  err: unknown,
): boolean {
  return toolName === 'back' && /timed? out|timeout/i.test(errorMessage(err));
}

function isStaleBrowserError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes('browser has been closed') ||
    message.includes('context has been closed') ||
    message.includes('page has been closed') ||
    message.includes('target page, context or browser has been closed') ||
    message.includes('no pages available')
  );
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function requiredString(value: unknown, name: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`Browser action requires ${name}.`);
  return normalized;
}

function requiredPositiveInteger(
  value: unknown,
  name: string,
  opts: { allowZero?: boolean } = {},
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < (opts.allowZero ? 0 : 1)
  ) {
    throw new Error(`Browser action requires positive integer ${name}.`);
  }
  return value;
}

function toOptionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
