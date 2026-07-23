import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

import {
  SLACK_CONNECTOR_ERROR_CODE,
  SLACK_PROVIDER,
  SlackConnectorError,
  type InviteSlackWorkspaceUserInput,
  type InviteSlackWorkspaceUserResult
} from "./slack.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const SHORT_SELECTOR_TIMEOUT_MS = 1_000;

const SELECTORS = {
  loginText: [
    /sign in to slack/i,
    /sign in to .*$/i,
    /sign in with google/i,
    /google apps account/i,
    /continue with google/i,
    /check your email/i,
    /enter your code/i,
    /two-factor/i,
    /single sign-on/i
  ],
  inviteEntryPoints: [
    { css: "button[aria-label='Invite People']" },
    { css: "button:has-text('Invite People')" },
    { css: "button[data-qa='page_header_primary_button']" },
    { role: "button", name: /invite people/i },
    { text: /invite people/i }
  ],
  emailInputs: [
    { css: ".ReactModal__Content [data-qa='invite_modal_select-input']" },
    { css: ".c-sk-modal [data-qa='invite_modal_select-input']" },
    { css: "#invite_modal_select" },
    { css: "[data-qa='invite_modal_select-input']" },
    { css: ".ReactModal__Content [role='combobox']" },
    { css: ".c-sk-modal [role='combobox']" }
  ],
  modalTitleBars: [
    { css: ".p-invite_form--admin_page_title" },
    { role: "heading", name: /invite people to/i },
    { text: /invite people to/i }
  ],
  nameInputs: [
    { css: ".ReactModal__Content input[placeholder='Full name']" },
    { css: ".c-sk-modal input[placeholder='Full name']" }
  ],
  submitButtons: [
    { css: ".ReactModal__Content button[aria-label='Send']" },
    { css: ".c-sk-modal button[aria-label='Send']" },
    { css: ".ReactModal__Content button:has-text('Send')" },
    { css: ".c-sk-modal button:has-text('Send')" },
    { css: "button[aria-label='Send']" },
    { css: "button:has-text('Send')" }
  ],
  successText: [
    /you’ve invited 1 person/i,
    /you've invited 1 person/i,
    /you’ve invited/i,
    /you've invited/i,
    /invite sent/i,
    /invitation sent/i,
    /has been invited/i,
    /invited successfully/i
  ],
  successSelectors: [
    { css: "[data-qa='confirmation-screen-title']" },
    { css: "[data-qa='confirmation-modal_body']" },
    { css: "[data-qa='invite-entity-workspace']" }
  ],
  highConfidenceSuccessSelectors: [
    { css: "[data-qa='confirmation-screen-title']" },
    { css: "[data-qa='invite-entity-workspace']" },
    { css: "[data-qa='invite-entity-status-message']" }
  ],
  highConfidenceSuccessText: [
    /invited as a coworker/i
  ]
} as const;

export type SlackBrowserInviteConnectorConfig = {
  workspaceUrl: string;
  profileDir: string;
  dryRun?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  screenshotPath?: string;
  browserClient?: SlackBrowserInviteClient;
};

export type SlackBrowserInviteClient = {
  launchPersistentContext(input: {
    profileDir: string;
    headless: boolean;
    timeoutMs: number;
  }): Promise<SlackBrowserContext>;
};

export type SlackBrowserContext = {
  pages(): SlackBrowserPage[];
  newPage(): Promise<SlackBrowserPage>;
  close(): Promise<void>;
};

export type SlackBrowserPage = {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  bringToFront(): Promise<void>;
  setDefaultTimeout(timeoutMs: number): void;
  waitForTimeout(timeoutMs: number): Promise<void>;
  keyboardType(text: string): Promise<void>;
  keyboardInsertText(text: string): Promise<void>;
  keyboardPress(key: string): Promise<void>;
  url(): string;
  getByRole(role: string, options: { name: RegExp }): SlackBrowserLocator;
  getByText(text: RegExp): SlackBrowserLocator;
  getByLabel(text: RegExp): SlackBrowserLocator;
  getByPlaceholder(text: RegExp): SlackBrowserLocator;
  locator(selector: string): SlackBrowserLocator;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
};

export type SlackBrowserLocator = {
  first(): SlackBrowserLocator;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  focus(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  type(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  blur(options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
};

type SelectorStep =
  | "login_check"
  | "invite_entry_point"
  | "email_input"
  | "name_input"
  | "submit_invite"
  | "success_confirmation";

type SelectorCandidate =
  | { role: string; name: RegExp }
  | { text: RegExp }
  | { label: RegExp }
  | { placeholder: RegExp }
  | { css: string };

export class SlackBrowserInviteConnector {
  private readonly workspaceUrl: string;
  private readonly profileDir: string;
  private readonly dryRun: boolean;
  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly screenshotPath?: string;
  private readonly browserClient: SlackBrowserInviteClient;

  constructor(config: SlackBrowserInviteConnectorConfig) {
    this.workspaceUrl = validateWorkspaceUrl(config.workspaceUrl);
    this.profileDir = config.profileDir;
    this.dryRun = config.dryRun ?? true;
    this.headless = config.headless ?? true;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.screenshotPath = config.screenshotPath;
    this.browserClient = config.browserClient ?? new PlaywrightSlackBrowserInviteClient();
  }

  async inviteUserToWorkspace(input: InviteSlackWorkspaceUserInput): Promise<InviteSlackWorkspaceUserResult> {
    const email = normalizeEmail(input.email);
    let context: SlackBrowserContext | undefined;

    try {
      context = await this.browserClient.launchPersistentContext({
        profileDir: this.profileDir,
        headless: this.headless,
        timeoutMs: this.timeoutMs
      });

      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(buildSlackAdminUrl(this.workspaceUrl), { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      await page.bringToFront();
      await this.ensureAdminPage(page);
      await this.assertLoggedIn(page);
      await clickFirstVisible(page, SELECTORS.inviteEntryPoints, "invite_entry_point", {
        timeoutMs: this.timeoutMs
      });
      await typeAndCommitFirstVisible(page, SELECTORS.emailInputs, email, "email_input");
      await clickFirstVisible(page, SELECTORS.modalTitleBars, "email_input", {
        force: true
      });
      await page.waitForTimeout(3_000);

      if (input.fullName) {
        await fillOptionalFirstVisible(page, SELECTORS.nameInputs, input.fullName);
      }

      if (this.screenshotPath) {
        await page.screenshot({ path: this.screenshotPath, fullPage: false });
      }

      if (this.dryRun) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          email,
          inviteSubmitted: false,
          dryRun: true,
          message: "Slack browser invite dry run reached the invite UI without submitting.",
          screenshotPath: this.screenshotPath
        };
      }

      await clickFirstVisible(page, SELECTORS.submitButtons, "submit_invite");
      await waitForSuccess(page, this.timeoutMs);

      return {
        provider: SLACK_PROVIDER,
        mode: "browser",
        email,
        inviteSubmitted: true,
        dryRun: false,
        message: "Slack browser invite was submitted.",
        screenshotPath: this.screenshotPath
      };
    } catch (error) {
      throw normalizeSlackBrowserInviteError(error);
    } finally {
      await context?.close();
    }
  }

  private async assertLoggedIn(page: SlackBrowserPage): Promise<void> {
    const currentUrl = page.url();

    if (isSlackLoginUrl(currentUrl)) {
      throw slackBrowserError({
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        message: "Slack browser profile is not logged in.",
        step: "login_check",
        currentUrl
      });
    }

    for (const text of SELECTORS.loginText) {
      const loginPrompt = page.getByText(text).first();

      if (await isVisible(loginPrompt)) {
      throw slackBrowserError({
          code: text.source.includes("code") || text.source.includes("single")
            ? SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
            : SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
          message: "Slack browser profile requires login, SSO, MFA, or email verification.",
          step: "login_check",
          currentUrl
        });
      }
    }
  }

  private async ensureAdminPage(page: SlackBrowserPage): Promise<void> {
    const adminUrl = buildSlackAdminUrl(this.workspaceUrl);
    const currentUrl = page.url();

    if (isSlackClientUrl(currentUrl)) {
      await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      await page.bringToFront();
    }
  }
}

class PlaywrightSlackBrowserInviteClient implements SlackBrowserInviteClient {
  async launchPersistentContext(input: {
    profileDir: string;
    headless: boolean;
    timeoutMs: number;
  }): Promise<SlackBrowserContext> {
    const context = await chromium.launchPersistentContext(input.profileDir, {
      headless: input.headless,
      viewport: null,
      timeout: input.timeoutMs,
      args: [
        "--ozone-platform=x11",
        "--use-gl=swiftshader",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-position=100,100",
        "--window-size=1280,900"
      ]
    });

    return new PlaywrightSlackBrowserContext(context);
  }
}

class PlaywrightSlackBrowserContext implements SlackBrowserContext {
  constructor(private readonly context: BrowserContext) {}

  pages(): SlackBrowserPage[] {
    return this.context.pages().map((page) => new PlaywrightSlackBrowserPage(page));
  }

  async newPage(): Promise<SlackBrowserPage> {
    return new PlaywrightSlackBrowserPage(await this.context.newPage());
  }

  close(): Promise<void> {
    return this.context.close();
  }
}

class PlaywrightSlackBrowserPage implements SlackBrowserPage {
  constructor(private readonly page: Page) {}

  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown> {
    return this.page.goto(url, options);
  }

  bringToFront(): Promise<void> {
    return this.page.bringToFront();
  }

  setDefaultTimeout(timeoutMs: number): void {
    this.page.setDefaultTimeout(timeoutMs);
  }

  waitForTimeout(timeoutMs: number): Promise<void> {
    return this.page.waitForTimeout(timeoutMs);
  }

  keyboardType(text: string): Promise<void> {
    return this.page.keyboard.type(text, { delay: 20 });
  }

  keyboardInsertText(text: string): Promise<void> {
    return this.page.keyboard.insertText(text);
  }

  keyboardPress(key: string): Promise<void> {
    return this.page.keyboard.press(key);
  }

  url(): string {
    return this.page.url();
  }

  getByRole(role: string, options: { name: RegExp }): SlackBrowserLocator {
    return this.page.getByRole(role as never, options);
  }

  getByText(text: RegExp): SlackBrowserLocator {
    return this.page.getByText(text);
  }

  getByLabel(text: RegExp): SlackBrowserLocator {
    return this.page.getByLabel(text);
  }

  getByPlaceholder(text: RegExp): SlackBrowserLocator {
    return this.page.getByPlaceholder(text);
  }

  locator(selector: string): SlackBrowserLocator {
    return this.page.locator(selector);
  }

  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown> {
    return this.page.screenshot(options);
  }
}

async function clickFirstVisible(
  page: SlackBrowserPage,
  candidates: readonly SelectorCandidate[],
  step: SelectorStep,
  options: { timeoutMs?: number; force?: boolean } = {}
): Promise<void> {
  const locator = await findFirstVisible(page, candidates, options.timeoutMs);

  if (!locator) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged,
      message: "Slack invite UI selector was not found.",
      step,
      currentUrl: page.url()
    });
  }

  const timeout = options.timeoutMs ?? SHORT_SELECTOR_TIMEOUT_MS;
  await locator.click({ timeout, force: options.force });
}

async function fillFirstVisible(
  page: SlackBrowserPage,
  candidates: readonly SelectorCandidate[],
  value: string,
  step: SelectorStep
): Promise<SlackBrowserLocator> {
  const locator = await findFirstVisible(page, candidates);

  if (!locator) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged,
      message: "Slack invite UI input selector was not found.",
      step,
      currentUrl: page.url()
    });
  }

  await locator.fill(value, { timeout: SHORT_SELECTOR_TIMEOUT_MS });
  return locator;
}

async function typeAndCommitFirstVisible(
  page: SlackBrowserPage,
  candidates: readonly SelectorCandidate[],
  value: string,
  step: SelectorStep
): Promise<SlackBrowserLocator> {
  const locator = await findFirstVisible(page, candidates);

  if (!locator) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged,
      message: "Slack invite UI input selector was not found.",
      step,
      currentUrl: page.url()
    });
  }

  await locator.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
  await locator.focus({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
  await page.keyboardType(value);
  await page.waitForTimeout(1_000);
  await page.keyboardPress("Tab");
  await page.waitForTimeout(1_000);

  return locator;
}


async function fillOptionalFirstVisible(
  page: SlackBrowserPage,
  candidates: readonly SelectorCandidate[],
  value: string
): Promise<void> {
  const locator = await findFirstVisible(page, candidates);

  if (locator) {
    try {
      await locator.fill(value, { timeout: SHORT_SELECTOR_TIMEOUT_MS });
    } catch {
      return;
    }
  }
}

async function pressOptional(locator: SlackBrowserLocator, key: string): Promise<void> {
  try {
    await locator.press(key, { timeout: SHORT_SELECTOR_TIMEOUT_MS });
  } catch {
    return;
  }
}

async function findFirstVisible(
  page: SlackBrowserPage,
  candidates: readonly SelectorCandidate[],
  timeoutMs = SHORT_SELECTOR_TIMEOUT_MS
): Promise<SlackBrowserLocator | null> {
  const perCandidateTimeoutMs = Math.max(
    SHORT_SELECTOR_TIMEOUT_MS,
    Math.floor(timeoutMs / Math.max(candidates.length, 1))
  );

  for (const candidate of candidates) {
    const locator = locatorFor(page, candidate).first();

    if (await waitForVisible(locator, perCandidateTimeoutMs)) {
      return locator;
    }
  }

  return null;
}

function locatorFor(page: SlackBrowserPage, candidate: SelectorCandidate): SlackBrowserLocator {
  if ("role" in candidate) {
    return page.getByRole(candidate.role, { name: candidate.name });
  }

  if ("text" in candidate) {
    return page.getByText(candidate.text);
  }

  if ("label" in candidate) {
    return page.getByLabel(candidate.label);
  }

  if ("placeholder" in candidate) {
    return page.getByPlaceholder(candidate.placeholder);
  }

  return page.locator(candidate.css);
}

async function waitForVisible(locator: SlackBrowserLocator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function isVisible(locator: SlackBrowserLocator, timeoutMs = SHORT_SELECTOR_TIMEOUT_MS): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: timeoutMs });
  } catch {
    return false;
  }
}

async function waitForSuccess(page: SlackBrowserPage, timeoutMs: number): Promise<void> {
  if (await hasHighConfidenceInviteConfirmation(page, timeoutMs)) {
    return;
  }

  throw slackBrowserError({
    code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed,
    message: "Slack invite confirmation was not shown after submitting the invite.",
    step: "success_confirmation",
    currentUrl: page.url()
  });
}

async function hasHighConfidenceInviteConfirmation(page: SlackBrowserPage, timeoutMs: number): Promise<boolean> {
  const confirmationTimeoutMs = Math.max(timeoutMs, 5_000);

  for (const candidate of [...SELECTORS.highConfidenceSuccessSelectors, ...SELECTORS.successSelectors]) {
    const locator = locatorFor(page, candidate).first();
    if (await isVisible(locator, 2_000)) {
      return true;
    }
  }

  for (const successText of [...SELECTORS.highConfidenceSuccessText, ...SELECTORS.successText]) {
    try {
      if (await isVisible(page.getByText(successText).first(), 2_000)) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  await page.waitForTimeout(3_000);
  return true;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateWorkspaceUrl(workspaceUrl: string): string {
  const url = new URL(workspaceUrl);

  if (url.protocol !== "https:") {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed,
      message: "Slack browser workspace URL must use https.",
      step: "login_check",
      currentUrl: workspaceUrl
    });
  }

  return url.toString();
}

function buildSlackAdminUrl(workspaceUrl: string): string {
  const url = new URL(workspaceUrl);
  url.pathname = "/admin";
  url.search = "";
  url.hash = "";

  return url.toString();
}

function isSlackLoginUrl(currentUrl: string): boolean {
  return /\/(signin|sign-in|login|sso|oauth|check-email|magic-link)/iu.test(currentUrl);
}

function isSlackClientUrl(currentUrl: string): boolean {
  return /^https:\/\/app\.slack\.com\/client\//iu.test(currentUrl);
}

function normalizeSlackBrowserInviteError(error: unknown): SlackConnectorError {
  if (error instanceof SlackConnectorError) {
    return error;
  }

  if (isTimeoutError(error)) {
    return new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout,
      message: "Slack browser invite timed out.",
      cause: error
    });
  }

  return new SlackConnectorError({
    code: SLACK_CONNECTOR_ERROR_CODE.browserUnknown,
    message: "Slack browser invite failed unexpectedly.",
    cause: error
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError" ||
    /timeout/i.test(error.message)
  );
}

function slackBrowserError(input: {
  code: typeof SLACK_CONNECTOR_ERROR_CODE[keyof typeof SLACK_CONNECTOR_ERROR_CODE];
  message: string;
  step: SelectorStep;
  currentUrl: string;
}): SlackConnectorError {
  return new SlackConnectorError({
    code: input.code,
    message: input.message,
    details: {
      step: input.step,
      currentUrl: safeUrl(input.currentUrl)
    }
  });
}

function safeUrl(currentUrl: string): string {
  try {
    const url = new URL(currentUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unknown";
  }
}
