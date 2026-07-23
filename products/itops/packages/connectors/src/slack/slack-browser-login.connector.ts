import { chmod, mkdir } from "node:fs/promises";

import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

import {
  SLACK_CONNECTOR_ERROR_CODE,
  SLACK_PROVIDER,
  SlackConnectorError
} from "./slack.types.js";

const SHORT_TIMEOUT_MS = 1_500;
const LOGIN_TIMEOUT_MS = 90_000;

export type SlackBrowserLoginMode = "manual" | "google_sso";

export type SlackBrowserLoginConnectorConfig = {
  workspaceUrl: string;
  profileDir: string;
  loginMode?: SlackBrowserLoginMode;
  loginEmail?: string;
  loginPassword?: string;
  headless?: boolean;
  timeoutMs?: number;
  browserClient?: SlackBrowserLoginClient;
};

export type SlackBrowserLoginResult = {
  provider: typeof SLACK_PROVIDER;
  mode: "browser";
  loginMode: SlackBrowserLoginMode;
  authenticated: boolean;
  loginRecovered: boolean;
  message: string;
};

export type SlackBrowserLoginClient = {
  launchPersistentContext(input: {
    profileDir: string;
    headless: boolean;
    timeoutMs: number;
  }): Promise<SlackBrowserLoginContext>;
};

export type SlackBrowserLoginContext = {
  pages(): SlackBrowserLoginPage[];
  newPage(): Promise<SlackBrowserLoginPage>;
  waitForClose(): Promise<void>;
  close(): Promise<void>;
};

export type SlackBrowserLoginPage = {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  bringToFront(): Promise<void>;
  setDefaultTimeout(timeoutMs: number): void;
  waitForTimeout(timeoutMs: number): Promise<void>;
  waitForLoadState(state: "networkidle", options?: { timeout?: number }): Promise<void>;
  url(): string;
  getByRole(role: string, options: { name: RegExp }): SlackBrowserLoginLocator;
  getByText(text: RegExp): SlackBrowserLoginLocator;
  getByLabel(text: RegExp): SlackBrowserLoginLocator;
  locator(selector: string): SlackBrowserLoginLocator;
};

export type SlackBrowserLoginLocator = {
  first(): SlackBrowserLoginLocator;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
};

export class SlackBrowserLoginConnector {
  private readonly workspaceUrl: string;
  private readonly profileDir: string;
  private readonly loginMode: SlackBrowserLoginMode;
  private readonly loginEmail?: string;
  private readonly loginPassword?: string;
  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly browserClient: SlackBrowserLoginClient;

  constructor(config: SlackBrowserLoginConnectorConfig) {
    this.workspaceUrl = validateWorkspaceUrl(config.workspaceUrl);
    this.profileDir = config.profileDir;
    this.loginMode = config.loginMode ?? "manual";
    this.loginEmail = config.loginEmail;
    this.loginPassword = config.loginPassword;
    this.headless = config.headless ?? true;
    this.timeoutMs = config.timeoutMs ?? LOGIN_TIMEOUT_MS;
    this.browserClient = config.browserClient ?? new PlaywrightSlackBrowserLoginClient();
  }

  async login(): Promise<SlackBrowserLoginResult> {
    let context: SlackBrowserLoginContext | undefined;
    let contextClosed = false;

    try {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      await chmod(this.profileDir, 0o700);

      context = await this.browserClient.launchPersistentContext({
        profileDir: this.profileDir,
        headless: this.headless,
        timeoutMs: this.timeoutMs
      });

      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(this.workspaceUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      await page.bringToFront();

      if (this.loginMode === "manual") {
        await context.waitForClose();
        contextClosed = true;

        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          loginMode: "manual",
          authenticated: true,
          loginRecovered: false,
          message: "Slack browser profile saved."
        };
      }

      this.assertGoogleSsoCredentials();

      const wasAuthenticated = await isSlackAuthenticated(page, this.workspaceUrl);

      if (!wasAuthenticated) {
        await loginWithGoogleSso(page, {
          workspaceUrl: this.workspaceUrl,
          email: this.loginEmail!,
          password: this.loginPassword!
        });
      }

      return {
        provider: SLACK_PROVIDER,
        mode: "browser",
        loginMode: "google_sso",
        authenticated: true,
        loginRecovered: !wasAuthenticated,
        message: wasAuthenticated
          ? "Slack browser profile is already authenticated."
          : "Slack browser profile was authenticated with Google SSO."
      };
    } catch (error) {
      throw normalizeSlackBrowserLoginError(error);
    } finally {
      if (!contextClosed) {
        await context?.close();
      }
    }
  }

  private assertGoogleSsoCredentials(): void {
    if (!this.loginEmail || !this.loginPassword) {
      throw slackBrowserLoginError({
        code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
        message: "Slack browser Google SSO login credentials are not configured."
      });
    }
  }
}

class PlaywrightSlackBrowserLoginClient implements SlackBrowserLoginClient {
  async launchPersistentContext(input: {
    profileDir: string;
    headless: boolean;
    timeoutMs: number;
  }): Promise<SlackBrowserLoginContext> {
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

    return new PlaywrightSlackBrowserLoginContext(context);
  }
}

class PlaywrightSlackBrowserLoginContext implements SlackBrowserLoginContext {
  constructor(private readonly context: BrowserContext) {}

  pages(): SlackBrowserLoginPage[] {
    return this.context.pages().map((page) => new PlaywrightSlackBrowserLoginPage(page));
  }

  async newPage(): Promise<SlackBrowserLoginPage> {
    return new PlaywrightSlackBrowserLoginPage(await this.context.newPage());
  }

  async waitForClose(): Promise<void> {
    await this.context.waitForEvent("close", { timeout: 0 });
  }

  close(): Promise<void> {
    return this.context.close();
  }
}

class PlaywrightSlackBrowserLoginPage implements SlackBrowserLoginPage {
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

  waitForLoadState(state: "networkidle", options?: { timeout?: number }): Promise<void> {
    return this.page.waitForLoadState(state, options);
  }

  url(): string {
    return this.page.url();
  }

  getByRole(role: string, options: { name: RegExp }): SlackBrowserLoginLocator {
    return this.page.getByRole(role as Parameters<Page["getByRole"]>[0], options);
  }

  getByText(text: RegExp): SlackBrowserLoginLocator {
    return this.page.getByText(text);
  }

  getByLabel(text: RegExp): SlackBrowserLoginLocator {
    return this.page.getByLabel(text);
  }

  locator(selector: string): SlackBrowserLoginLocator {
    return this.page.locator(selector);
  }
}

async function loginWithGoogleSso(
  page: SlackBrowserLoginPage,
  input: { workspaceUrl: string; email: string; password: string }
): Promise<void> {
  await clickFirstVisible(page, [
    page.locator("#index_google_sign_in_with_google"),
    page.locator("a[href*='/sso/google/start']"),
    page.getByRole("link", { name: /sign in with google/i }),
    page.getByText(/sign in with google/i),
    page.getByRole("button", { name: /continue with google/i }),
    page.getByRole("link", { name: /continue with google/i }),
    page.getByText(/continue with google/i)
  ], "Slack Sign in with Google button was not found.");
  await waitForLoginStepLoad(page);

  await fillGoogleEmail(page, input.email);
  await failIfUnsupportedChallenge(page);
  await fillGooglePassword(page, input.password);
  await failIfUnsupportedChallenge(page);

  if (isMicrosoftLoginUrl(page.url()) || await hasVisible(page.getByText(/sign in/i))) {
    await fillMicrosoftEmailIfNeeded(page, input.email);
    await failIfUnsupportedChallenge(page);
    await fillMicrosoftPassword(page, input.password);
    await handleMicrosoftStaySignedIn(page);
    await failIfUnsupportedChallenge(page);
  }

  await waitForSlackAuthenticated(page, input.workspaceUrl);
}

async function fillGoogleEmail(page: SlackBrowserLoginPage, email: string): Promise<void> {
  await fillFirstVisible(page, [
    page.locator("input[type='email']"),
    page.locator("#identifierId"),
    page.getByLabel(/email|phone/i)
  ], email, "Google email input was not found.");

  await clickFirstVisible(page, [
    page.locator("#identifierNext button"),
    page.locator("button:has-text('Next')"),
    page.getByRole("button", { name: /next/i })
  ], "Google email next button was not found.");
  await waitForLoginStepLoad(page);
}

async function fillGooglePassword(page: SlackBrowserLoginPage, password: string): Promise<void> {
  await fillFirstVisible(page, [
    page.locator("input[name='Passwd']"),
    page.locator("input[type='password']"),
    page.getByLabel(/password/i)
  ], password, "Google password input was not found.");

  await clickFirstVisible(page, [
    page.locator("#passwordNext button"),
    page.locator("button:has-text('Next')"),
    page.getByRole("button", { name: /next/i })
  ], "Google password next button was not found.");
  await waitForLoginStepLoad(page);
}

async function fillMicrosoftEmailIfNeeded(page: SlackBrowserLoginPage, email: string): Promise<void> {
  const emailInput = await firstVisible([
    page.locator("input[type='email']"),
    page.locator("input[name='loginfmt']"),
    page.locator("#i0116")
  ]);

  if (!emailInput) {
    return;
  }

  await emailInput.fill(email);
  await clickFirstVisible(page, [
    page.locator("input[type='submit']"),
    page.locator("#idSIButton9"),
    page.getByRole("button", { name: /next/i })
  ], "Microsoft email next button was not found.");
  await waitForLoginStepLoad(page);
}

async function fillMicrosoftPassword(page: SlackBrowserLoginPage, password: string): Promise<void> {
  await fillFirstVisible(page, [
    page.locator("input[type='password']"),
    page.locator("input[name='passwd']"),
    page.locator("#i0118")
  ], password, "Microsoft password input was not found.");

  await clickFirstVisible(page, [
    page.locator("input[type='submit']"),
    page.locator("#idSIButton9"),
    page.getByRole("button", { name: /sign in/i })
  ], "Microsoft sign in button was not found.");
  await waitForLoginStepLoad(page);
}

async function handleMicrosoftStaySignedIn(page: SlackBrowserLoginPage): Promise<void> {
  const staySignedInText = page.getByText(/stay signed in/i);

  if (!await hasVisible(staySignedInText, 5_000)) {
    return;
  }

  const yesButton = await firstVisible([
    page.locator("#idSIButton9"),
    page.getByRole("button", { name: /^yes$/i })
  ]);

  if (yesButton) {
    await yesButton.click();
    await waitForLoginStepLoad(page);
  }
}

async function waitForSlackAuthenticated(page: SlackBrowserLoginPage, workspaceUrl: string): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isSlackAuthenticated(page, workspaceUrl)) {
      return;
    }

    await failIfUnsupportedChallenge(page, 500);
    await page.waitForTimeout(1_000);
  }

  throw slackBrowserLoginError({
    code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout,
    message: "Slack browser Google SSO login did not return to an authenticated Slack session."
  });
}

async function isSlackAuthenticated(page: SlackBrowserLoginPage, workspaceUrl: string): Promise<boolean> {
  const currentUrl = safeUrl(page.url());
  const workspaceOrigin = new URL(workspaceUrl).origin;

  if (currentUrl.startsWith(`${workspaceOrigin}/admin`) || currentUrl.startsWith(`${workspaceOrigin}/client`)) {
    return true;
  }

  if (currentUrl.startsWith("https://app.slack.com/client/")) {
    return true;
  }

  return Boolean(await firstVisible([
    page.getByRole("button", { name: /invite people/i }),
    page.getByText(/manage members/i),
    page.getByText(/open in slack/i)
  ], 1_000));
}

async function failIfUnsupportedChallenge(page: SlackBrowserLoginPage, timeoutMs = SHORT_TIMEOUT_MS): Promise<void> {
  const challenge = await firstVisible([
    page.getByText(/verify it's you/i),
    page.getByText(/2-step verification/i),
    page.getByText(/two-step verification/i),
    page.getByText(/enter a verification code/i),
    page.getByText(/approve sign in request/i),
    page.getByText(/open your.*authenticator/i),
    page.getByText(/use your passkey/i),
    page.getByText(/captcha/i),
    page.getByText(/recovery email/i),
    page.getByText(/help us secure your account/i),
    page.getByText(/more information required/i)
  ], timeoutMs);

  if (challenge) {
    throw slackBrowserLoginError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired,
      message: "Slack browser Google SSO login requires MFA, SSO approval, CAPTCHA, recovery, or another unsupported challenge."
    });
  }
}

async function fillFirstVisible(
  page: SlackBrowserLoginPage,
  locators: SlackBrowserLoginLocator[],
  value: string,
  errorMessage: string
): Promise<void> {
  const locator = await firstVisible(locators);

  if (!locator) {
    throw slackBrowserLoginError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged,
      message: errorMessage
    });
  }

  await locator.fill(value);
}

async function clickFirstVisible(
  page: SlackBrowserLoginPage,
  locators: SlackBrowserLoginLocator[],
  errorMessage: string
): Promise<void> {
  const locator = await firstVisible(locators);

  if (!locator) {
    throw slackBrowserLoginError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn,
      message: errorMessage
    });
  }

  await locator.click();
}

async function firstVisible(
  locators: SlackBrowserLoginLocator[],
  timeoutMs = SHORT_TIMEOUT_MS
): Promise<SlackBrowserLoginLocator | null> {
  const perLocatorTimeoutMs = Math.max(250, Math.floor(timeoutMs / Math.max(locators.length, 1)));

  for (const locator of locators) {
    const first = locator.first();

    if (await hasVisible(first, perLocatorTimeoutMs)) {
      return first;
    }
  }

  return null;
}

async function hasVisible(locator: SlackBrowserLoginLocator, timeoutMs = SHORT_TIMEOUT_MS): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function waitForLoginStepLoad(page: SlackBrowserLoginPage): Promise<void> {
  await Promise.race([
    page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined),
    page.waitForTimeout(3_000)
  ]);

  await page.waitForTimeout(1_500);
}

function validateWorkspaceUrl(value: string): string {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("SLACK_BROWSER_WORKSPACE_URL must use https.");
  }

  return url.toString().replace(/\/$/u, "");
}

function isMicrosoftLoginUrl(currentUrl: string): boolean {
  return /^https:\/\/login\.microsoftonline\.com\//iu.test(currentUrl) || /^https:\/\/login\.live\.com\//iu.test(currentUrl);
}

function safeUrl(currentUrl: string): string {
  try {
    const url = new URL(currentUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

function normalizeSlackBrowserLoginError(error: unknown): SlackConnectorError {
  if (error instanceof SlackConnectorError) {
    return error;
  }

  if (isTimeoutError(error)) {
    return slackBrowserLoginError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout,
      message: "Slack browser login timed out.",
      cause: error
    });
  }

  return slackBrowserLoginError({
    code: SLACK_CONNECTOR_ERROR_CODE.browserUnknown,
    message: "Slack browser login failed.",
    cause: error
  });
}

function slackBrowserLoginError(input: {
  code: typeof SLACK_CONNECTOR_ERROR_CODE[keyof typeof SLACK_CONNECTOR_ERROR_CODE];
  message: string;
  cause?: unknown;
}): SlackConnectorError {
  return new SlackConnectorError({
    code: input.code,
    message: input.message,
    cause: input.cause
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError" ||
    /timeout .* exceeded|timed out/iu.test(error.message)
  );
}
