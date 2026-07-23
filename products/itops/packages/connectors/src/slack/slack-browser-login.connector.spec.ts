import { describe, expect, it, vi } from "vitest";

import {
  SlackBrowserLoginConnector,
  type SlackBrowserLoginClient,
  type SlackBrowserLoginContext,
  type SlackBrowserLoginLocator,
  type SlackBrowserLoginPage
} from "./slack-browser-login.connector.js";
import { SLACK_CONNECTOR_ERROR_CODE, SlackConnectorError } from "./slack.types.js";

describe("SlackBrowserLoginConnector", () => {
  it("returns authenticated without clicking login when the profile is already logged in", async () => {
    const page = makePage({
      currentUrl: "https://example.slack.com/admin"
    });
    const connector = makeConnector(page);

    await expect(connector.login()).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      loginMode: "google_sso",
      authenticated: true,
      loginRecovered: false,
      message: "Slack browser profile is already authenticated."
    });
    expect(page.clicks).toEqual([]);
  });

  it("automates Slack Google SSO and Microsoft redirect login", async () => {
    const page = makePage({
      currentUrl: "https://example.slack.com/signin",
      visibleSelectors: [selectorKey("css", "#index_google_sign_in_with_google")]
    });
    const connector = makeConnector(page);

    await expect(connector.login()).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      loginMode: "google_sso",
      authenticated: true,
      loginRecovered: true
    });
    expect(page.fills).toEqual([
      { selector: selectorKey("css", "input[type='email']"), value: "admin@example.com" },
      { selector: selectorKey("css", "input[name='Passwd']"), value: "secret-password" },
      { selector: selectorKey("css", "input[type='email']"), value: "admin@example.com" },
      { selector: selectorKey("css", "input[type='password']"), value: "secret-password" }
    ]);
    expect(page.url()).toBe("https://example.slack.com/admin");
  });

  it("throws slack_browser_mfa_or_sso_required for unsupported login challenges", async () => {
    const page = makePage({
      currentUrl: "https://example.slack.com/signin",
      visibleSelectors: [selectorKey("css", "#index_google_sign_in_with_google")],
      challengeAfterGoogleEmail: true
    });
    const connector = makeConnector(page);

    await expect(connector.login()).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
    } satisfies Partial<SlackConnectorError>);
  });
});

function makeConnector(page: FakeSlackBrowserLoginPage): SlackBrowserLoginConnector {
  return new SlackBrowserLoginConnector({
    workspaceUrl: "https://example.slack.com",
    profileDir: "/tmp/itops-slack-browser-login-test-profile",
    loginMode: "google_sso",
    loginEmail: "admin@example.com",
    loginPassword: "secret-password",
    browserClient: makeBrowserClient(page)
  });
}

function makeBrowserClient(page: FakeSlackBrowserLoginPage): SlackBrowserLoginClient {
  return {
    launchPersistentContext: vi.fn(async () => new FakeSlackBrowserLoginContext(page))
  };
}

function makePage(input: {
  currentUrl: string;
  visibleSelectors?: string[];
  challengeAfterGoogleEmail?: boolean;
}): FakeSlackBrowserLoginPage {
  return new FakeSlackBrowserLoginPage(input.currentUrl, input.visibleSelectors ?? [], input.challengeAfterGoogleEmail ?? false);
}

function selectorKey(kind: "role", role: string, name: RegExp): string;
function selectorKey(kind: "text" | "label", value: RegExp): string;
function selectorKey(kind: "css", value: string): string;
function selectorKey(kind: "role" | "text" | "label" | "css", value: string | RegExp, name?: RegExp): string {
  if (kind === "role") {
    return `${kind}:${value}:${name?.toString()}`;
  }

  return `${kind}:${value.toString()}`;
}

class FakeSlackBrowserLoginContext implements SlackBrowserLoginContext {
  constructor(private readonly page: FakeSlackBrowserLoginPage) {}

  pages(): SlackBrowserLoginPage[] {
    return [this.page];
  }

  async newPage(): Promise<SlackBrowserLoginPage> {
    return this.page;
  }

  async waitForClose(): Promise<void> {}

  async close(): Promise<void> {}
}

class FakeSlackBrowserLoginPage implements SlackBrowserLoginPage {
  readonly clicks: string[] = [];
  readonly fills: Array<{ selector: string; value: string }> = [];
  private readonly visibleSelectors: Set<string>;
  private currentUrl: string;
  private readonly challengeAfterGoogleEmail: boolean;

  constructor(currentUrl: string, visibleSelectors: string[], challengeAfterGoogleEmail: boolean) {
    this.currentUrl = currentUrl;
    this.visibleSelectors = new Set(visibleSelectors);
    this.challengeAfterGoogleEmail = challengeAfterGoogleEmail;
  }

  async goto(url: string): Promise<void> {
    if (this.currentUrl === "about:blank") {
      this.currentUrl = url;
    }
  }

  async bringToFront(): Promise<void> {}

  setDefaultTimeout(): void {}

  async waitForTimeout(): Promise<void> {}

  async waitForLoadState(): Promise<void> {}

  url(): string {
    return this.currentUrl;
  }

  getByRole(role: string, options: { name: RegExp }): SlackBrowserLoginLocator {
    return new FakeSlackBrowserLoginLocator(this, selectorKey("role", role, options.name));
  }

  getByText(text: RegExp): SlackBrowserLoginLocator {
    return new FakeSlackBrowserLoginLocator(this, selectorKey("text", text));
  }

  getByLabel(text: RegExp): SlackBrowserLoginLocator {
    return new FakeSlackBrowserLoginLocator(this, selectorKey("label", text));
  }

  locator(selector: string): SlackBrowserLoginLocator {
    return new FakeSlackBrowserLoginLocator(this, selectorKey("css", selector));
  }

  isSelectorVisible(selector: string): boolean {
    return this.visibleSelectors.has(selector);
  }

  recordFill(selector: string, value: string): void {
    this.fills.push({ selector, value });
  }

  recordClick(selector: string): void {
    this.clicks.push(selector);

    if (selector === selectorKey("css", "#index_google_sign_in_with_google")) {
      this.visibleSelectors.clear();
      this.visibleSelectors.add(selectorKey("css", "input[type='email']"));
      this.visibleSelectors.add(selectorKey("css", "#identifierNext button"));
      return;
    }

    if (selector === selectorKey("css", "#identifierNext button")) {
      this.visibleSelectors.clear();
      if (this.challengeAfterGoogleEmail) {
        this.visibleSelectors.add(selectorKey("text", /verify it's you/i));
        return;
      }

      this.visibleSelectors.add(selectorKey("css", "input[name='Passwd']"));
      this.visibleSelectors.add(selectorKey("css", "#passwordNext button"));
      return;
    }

    if (selector === selectorKey("css", "#passwordNext button")) {
      this.currentUrl = "https://login.microsoftonline.com/example";
      this.visibleSelectors.clear();
      this.visibleSelectors.add(selectorKey("css", "input[type='email']"));
      this.visibleSelectors.add(selectorKey("css", "input[type='submit']"));
      return;
    }

    if (selector === selectorKey("css", "input[type='submit']") && this.hasFilled(selectorKey("css", "input[type='password']"))) {
      this.visibleSelectors.clear();
      this.visibleSelectors.add(selectorKey("text", /stay signed in/i));
      this.visibleSelectors.add(selectorKey("css", "#idSIButton9"));
      return;
    }

    if (selector === selectorKey("css", "input[type='submit']") && this.hasFilled(selectorKey("css", "input[name='Passwd']"))) {
      this.visibleSelectors.clear();
      this.visibleSelectors.add(selectorKey("css", "input[type='password']"));
      this.visibleSelectors.add(selectorKey("css", "input[type='submit']"));
      return;
    }

    if (selector === selectorKey("css", "#idSIButton9")) {
      this.currentUrl = "https://example.slack.com/admin";
      this.visibleSelectors.clear();
    }
  }

  private hasFilled(selector: string): boolean {
    return this.fills.some((fill) => fill.selector === selector);
  }
}

class FakeSlackBrowserLoginLocator implements SlackBrowserLoginLocator {
  constructor(
    private readonly page: FakeSlackBrowserLoginPage,
    private readonly selector: string
  ) {}

  first(): SlackBrowserLoginLocator {
    return this;
  }

  async click(): Promise<void> {
    this.page.recordClick(this.selector);
  }

  async fill(value: string): Promise<void> {
    this.page.recordFill(this.selector, value);
  }

  async waitFor(): Promise<void> {
    if (!this.page.isSelectorVisible(this.selector)) {
      const error = new Error("Timeout 10000ms exceeded.");
      error.name = "TimeoutError";
      throw error;
    }
  }
}
