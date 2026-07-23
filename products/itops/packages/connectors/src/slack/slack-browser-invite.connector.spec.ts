import { describe, expect, it, vi } from "vitest";

import {
  SlackBrowserInviteConnector,
  type SlackBrowserContext,
  type SlackBrowserInviteClient,
  type SlackBrowserLocator,
  type SlackBrowserPage
} from "./slack-browser-invite.connector.js";
import { SLACK_CONNECTOR_ERROR_CODE, SlackConnectorError } from "./slack.types.js";

describe("SlackBrowserInviteConnector", () => {
  it("fills the invite UI without submitting in dry-run mode", async () => {
    const page = makePage({
      visibleSelectors: [
        selectorKey("css", "button[data-qa='page_header_primary_button'][aria-label='Invite People']"),
        selectorKey("css", "[data-qa='invite_modal_select-input']"),
        selectorKey("css", ".p-invite_form--admin_page_title")
      ]
    });
    const connector = makeConnector(page, { dryRun: true });

    await expect(connector.inviteUserToWorkspace({
      email: " Temp.User@Example.com ",
      fullName: "Temp User"
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      email: "temp.user@example.com",
      inviteSubmitted: false,
      dryRun: true,
      message: "Slack browser invite dry run reached the invite UI without submitting.",
      screenshotPath: undefined
    });
    expect(page.gotoUrls).toEqual(["https://example.slack.com/admin"]);
    expect(page.clicks).toEqual([
      selectorKey("css", "button[data-qa='page_header_primary_button'][aria-label='Invite People']"),
      selectorKey("css", "[data-qa='invite_modal_select-input']"),
      selectorKey("css", ".p-invite_form--admin_page_title")
    ]);
    expect(page.types).toEqual([]);
    expect(page.presses).toEqual([]);
    expect(page.keyboardTypes).toEqual([]);
    expect(page.keyboardInsertTexts).toEqual(["temp.user@example.com"]);
    expect(page.keyboardPresses).toEqual(["Enter"]);
  });

  it("submits the invite in live mode", async () => {
    const page = makePage({
      visibleSelectors: [
        selectorKey("css", "button[data-qa='page_header_primary_button'][aria-label='Invite People']"),
        selectorKey("css", "[data-qa='invite_modal_select-input']"),
        selectorKey("css", ".p-invite_form--admin_page_title"),
        selectorKey("css", ".c-sk-modal_footer_actions button[aria-label='Send']:not([aria-disabled='true'])"),
        selectorKey("css", "[data-qa='confirmation-screen-title']"),
        selectorKey("css", "[data-qa='invite-entity-workspace']"),
        selectorKey("css", "[data-qa='invite-entity-status-message']"),
        selectorKey("text", /you’ve invited 1 person/i),
        selectorKey("text", /invited as a coworker/i)
      ]
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.inviteUserToWorkspace({
      email: "temp.user@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      email: "temp.user@example.com",
      inviteSubmitted: true,
      dryRun: false
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "button[data-qa='page_header_primary_button'][aria-label='Invite People']"),
      selectorKey("css", "[data-qa='invite_modal_select-input']"),
      selectorKey("css", ".p-invite_form--admin_page_title"),
      selectorKey("css", ".c-sk-modal_footer_actions button[aria-label='Send']:not([aria-disabled='true'])")
    ]);
  });

  it("does not treat a partial confirmation screen as a submitted invite", async () => {
    const page = makePage({
      visibleSelectors: [
        selectorKey("css", "button[data-qa='page_header_primary_button'][aria-label='Invite People']"),
        selectorKey("css", "[data-qa='invite_modal_select-input']"),
        selectorKey("css", ".p-invite_form--admin_page_title"),
        selectorKey("css", ".c-sk-modal_footer_actions button[aria-label='Send']:not([aria-disabled='true'])"),
        selectorKey("css", "[data-qa='confirmation-screen-title']")
      ]
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.inviteUserToWorkspace({
      email: "temp.user@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteFailed,
      details: {
        step: "success_confirmation"
      }
    } satisfies Partial<SlackConnectorError>);
  });

  it("throws slack_browser_not_logged_in when Slack redirects to login", async () => {
    const page = makePage({
      gotoUrl: "https://app.slack.com/signin"
    });
    const connector = makeConnector(page);

    await expect(connector.inviteUserToWorkspace({
      email: "temp.user@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn
    } satisfies Partial<SlackConnectorError>);
  });

  it("throws slack_browser_mfa_or_sso_required when Slack asks for SSO", async () => {
    const page = makePage({
      visibleSelectors: [selectorKey("text", /single sign-on/i)]
    });
    const connector = makeConnector(page);

    await expect(connector.inviteUserToWorkspace({
      email: "temp.user@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserMfaOrSsoRequired
    } satisfies Partial<SlackConnectorError>);
  });

  it("throws slack_browser_invite_ui_changed when invite entry point is missing", async () => {
    const page = makePage();
    const connector = makeConnector(page);

    await expect(connector.inviteUserToWorkspace({
      email: "temp.user@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserInviteUiChanged,
      details: {
        step: "invite_entry_point"
      }
    } satisfies Partial<SlackConnectorError>);
  });

  it("maps Playwright-style timeout errors to slack_browser_timeout", async () => {
    const timeoutError = new Error("Timeout 30000ms exceeded.");
    timeoutError.name = "TimeoutError";
    const page = makePage({
      gotoError: timeoutError
    });
    const connector = makeConnector(page);

    await expect(connector.inviteUserToWorkspace({
      email: "temp.user@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout
    } satisfies Partial<SlackConnectorError>);
  });
});

function makeConnector(
  page: FakeSlackBrowserPage,
  options: {
    dryRun?: boolean;
  } = {}
): SlackBrowserInviteConnector {
  return new SlackBrowserInviteConnector({
    workspaceUrl: "https://example.slack.com",
    profileDir: "/tmp/slack-browser-profile",
    dryRun: options.dryRun ?? true,
    browserClient: makeBrowserClient(page)
  });
}

function makeBrowserClient(page: FakeSlackBrowserPage): SlackBrowserInviteClient {
  return {
    launchPersistentContext: vi.fn(async () => new FakeSlackBrowserContext(page))
  };
}

function makePage(input: {
  currentUrl?: string;
  gotoUrl?: string;
  visibleSelectors?: string[];
  gotoError?: Error;
} = {}): FakeSlackBrowserPage {
  return new FakeSlackBrowserPage({
    currentUrl: input.currentUrl ?? "https://example.slack.com/client/T123/C123",
    gotoUrl: input.gotoUrl,
    visibleSelectors: input.visibleSelectors ?? [],
    gotoError: input.gotoError
  });
}

function selectorKey(kind: "role", role: string, name: RegExp): string;
function selectorKey(kind: "text" | "label" | "placeholder", value: RegExp): string;
function selectorKey(kind: "css", value: string): string;
function selectorKey(kind: "role" | "text" | "label" | "placeholder" | "css", value: string | RegExp, name?: RegExp): string {
  if (kind === "role") {
    return `${kind}:${value}:${name?.toString()}`;
  }

  return `${kind}:${value.toString()}`;
}

class FakeSlackBrowserContext implements SlackBrowserContext {
  closed = false;

  constructor(private readonly page: FakeSlackBrowserPage) {}

  pages(): SlackBrowserPage[] {
    return [this.page];
  }

  async newPage(): Promise<SlackBrowserPage> {
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSlackBrowserPage implements SlackBrowserPage {
  readonly gotoUrls: string[] = [];
  readonly clicks: string[] = [];
  readonly fills: Array<{ selector: string; value: string }> = [];
  readonly types: Array<{ selector: string; value: string }> = [];
  readonly presses: Array<{ selector: string; key: string }> = [];
  readonly keyboardTypes: string[] = [];
  readonly keyboardInsertTexts: string[] = [];
  readonly keyboardPresses: string[] = [];
  private readonly visibleSelectors: Set<string>;
  private readonly gotoError?: Error;
  private readonly gotoUrl?: string;
  private currentUrl: string;

  constructor(input: {
    currentUrl: string;
    gotoUrl?: string;
    visibleSelectors: string[];
    gotoError?: Error;
  }) {
    this.currentUrl = input.currentUrl;
    this.gotoUrl = input.gotoUrl;
    this.visibleSelectors = new Set(input.visibleSelectors);
    this.gotoError = input.gotoError;
  }

  async goto(url: string): Promise<void> {
    if (this.gotoError) {
      throw this.gotoError;
    }

    this.gotoUrls.push(url);
    this.currentUrl = this.gotoUrl ?? url;
  }

  async bringToFront(): Promise<void> {}

  setDefaultTimeout(): void {}

  async waitForTimeout(): Promise<void> {}

  async keyboardType(text: string): Promise<void> {
    this.keyboardTypes.push(text);
  }

  async keyboardInsertText(text: string): Promise<void> {
    this.keyboardInsertTexts.push(text);
  }

  async keyboardPress(key: string): Promise<void> {
    this.keyboardPresses.push(key);
  }

  url(): string {
    return this.currentUrl;
  }

  getByRole(role: string, options: { name: RegExp }): SlackBrowserLocator {
    return new FakeSlackBrowserLocator(this, selectorKey("role", role, options.name));
  }

  getByText(text: RegExp): SlackBrowserLocator {
    return new FakeSlackBrowserLocator(this, selectorKey("text", text));
  }

  getByLabel(text: RegExp): SlackBrowserLocator {
    return new FakeSlackBrowserLocator(this, selectorKey("label", text));
  }

  getByPlaceholder(text: RegExp): SlackBrowserLocator {
    return new FakeSlackBrowserLocator(this, selectorKey("placeholder", text));
  }

  locator(selector: string): SlackBrowserLocator {
    return new FakeSlackBrowserLocator(this, selectorKey("css", selector));
  }

  async screenshot(): Promise<void> {}

  isSelectorVisible(selector: string): boolean {
    return this.visibleSelectors.has(selector);
  }

  recordClick(selector: string): void {
    this.clicks.push(selector);
  }

  recordFill(selector: string, value: string): void {
    this.fills.push({ selector, value });
  }

  recordType(selector: string, value: string): void {
    this.types.push({ selector, value });
  }

  recordPress(selector: string, key: string): void {
    this.presses.push({ selector, key });
  }
}

class FakeSlackBrowserLocator implements SlackBrowserLocator {
  constructor(
    private readonly page: FakeSlackBrowserPage,
    private readonly selector: string
  ) {}

  first(): SlackBrowserLocator {
    return this;
  }

  async isVisible(): Promise<boolean> {
    return this.page.isSelectorVisible(this.selector);
  }

  async click(): Promise<void> {
    this.page.recordClick(this.selector);
  }

  async focus(): Promise<void> {}

  async fill(value: string): Promise<void> {
    this.page.recordFill(this.selector, value);
  }

  async type(value: string): Promise<void> {
    this.page.recordType(this.selector, value);
  }

  async press(key: string): Promise<void> {
    this.page.recordPress(this.selector, key);
  }

  async blur(): Promise<void> {}

  async waitFor(): Promise<void> {
    if (!this.page.isSelectorVisible(this.selector)) {
      const error = new Error("Timeout 10000ms exceeded.");
      error.name = "TimeoutError";
      throw error;
    }
  }
}
