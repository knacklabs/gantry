import { describe, expect, it, vi } from "vitest";

import {
  SlackBrowserWorkspaceRevokeConnector,
  type SlackBrowserWorkspaceRevokeClient,
  type SlackBrowserWorkspaceRevokeContext,
  type SlackBrowserWorkspaceRevokeLocator,
  type SlackBrowserWorkspaceRevokePage
} from "./slack-browser-workspace-revoke.connector.js";
import { SLACK_CONNECTOR_ERROR_CODE, SlackConnectorError } from "./slack.types.js";

describe("SlackBrowserWorkspaceRevokeConnector", () => {
  it("treats duplicate pinned-grid rows with one data-qa-id as one target user", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "", status: "", visible: true },
        { slackUserId: "U123", email: "target@example.com", status: "Active", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']"),
        selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: true });

    await expect(connector.revokeUserFromWorkspace({
      email: " Target@Example.com "
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: false,
      alreadyInactive: false,
      dryRun: true,
      message: "Slack browser revoke dry run verified the member email and reached the deactivate confirmation modal without confirming."
    });
    expect(page.fills).toEqual([{
      selector: selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
      value: "target@example.com"
    }]);
    expect(page.keyboardPresses).toEqual(["Enter"]);
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("css", "button[data-qa='ws-members-action_deactivate']")
    ]);
  });

  it("fails safely when search resolves to more than one unique user", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Active", visible: true },
        { slackUserId: "U456", email: "target.alias@example.com", status: "Active", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']")
      ]
    });
    const connector = makeConnector(page);

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      details: {
        step: "member_row"
      }
    } satisfies Partial<SlackConnectorError>);
    expect(page.clicks).toEqual([]);
  });

  it("fails safely when the unique result email does not match exactly", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "other@example.com", status: "Active", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page);

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      details: {
        step: "member_row"
      }
    } satisfies Partial<SlackConnectorError>);
    expect(page.clicks).toEqual([]);
  });

  it("fails safely when the row-scoped actions button is missing", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Active", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']")
      ],
      actionButtonCounts: new Map([["U123", 0]])
    });
    const connector = makeConnector(page);

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      details: {
        step: "member_actions"
      }
    } satisfies Partial<SlackConnectorError>);
    expect(page.clicks).toEqual([]);
  });

  it("treats an inactive unique result as idempotently already revoked", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Deactivated", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_activate']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page);

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: true,
      alreadyInactive: true
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']")
    ]);
  });

  it("revokes a pending workspace invitation from the row actions menu", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Invited", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']"),
        selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: true,
      alreadyInactive: false,
      dryRun: false,
      message: "Slack workspace invitation was revoked."
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("css", "button[data-qa='ws-members-action_deactivate']"),
      selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
    ]);
  });

  it("uses the Revoke invitation menu item even when the status column is not explicit", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Pending", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("role", "menuitem", /revoke invitation/i),
        selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: true,
      alreadyInactive: false,
      dryRun: false,
      message: "Slack workspace invitation was revoked."
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("role", "menuitem", /revoke invitation/i),
      selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
    ]);
    expect(page.getRows()[0]?.visible).toBe(false);
  });

  it("uses Revoke invitation when the row status looks inactive but the menu shows a pending invite", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Deactivated", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("role", "menuitem", /revoke invitation/i),
        selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: true,
      alreadyInactive: false,
      dryRun: false,
      message: "Slack workspace invitation was revoked."
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("role", "menuitem", /revoke invitation/i),
      selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
    ]);
    expect(page.getRows()[0]?.visible).toBe(false);
  });

  it("does not revoke a pending workspace invitation during dry run", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Invitation pending", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']"),
        selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: true });

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: false,
      alreadyInactive: false,
      dryRun: true,
      message: "Slack browser revoke dry run verified the pending invitation and reached the revoke invitation confirmation modal without confirming."
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("css", "button[data-qa='ws-members-action_deactivate']")
    ]);
    expect(page.getRows()[0]?.visible).toBe(true);
  });

  it("confirms live deactivation by finding Activate account in the row actions menu", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Active", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']"),
        selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']"),
        selectorKey("css", "button[data-qa='ws-members-action_activate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.revokeUserFromWorkspace({
      email: "target@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      operation: "workspace_revoke",
      email: "target@example.com",
      revoked: true,
      alreadyInactive: false,
      dryRun: false
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("css", "button[data-qa='ws-members-action_deactivate']"),
      selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']"),
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']")
    ]);
  });

  it("activates a deactivated workspace member from the row actions menu", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Deactivated", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_activate']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.activateUserInWorkspace({
      email: "target@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      operation: "workspace_activate",
      email: "target@example.com",
      activated: true,
      alreadyActive: false,
      notFound: false,
      dryRun: false
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("css", "button[data-qa='ws-members-action_activate']"),
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']")
    ]);
  });

  it("selects Regular Member and saves when Slack asks for account type during activation", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Deactivated", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_activate']"),
        selectorKey("css", "label[for='change-account-type-member']"),
        selectorKey("css", "button[data-qa='change_account_type_save_btn'][aria-label='Save']"),
        selectorKey("css", "button[data-qa='ws-members-action_deactivate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.activateUserInWorkspace({
      email: "target@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      operation: "workspace_activate",
      email: "target@example.com",
      activated: true,
      alreadyActive: false,
      notFound: false,
      dryRun: false
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']"),
      selectorKey("css", "button[data-qa='ws-members-action_activate']"),
      selectorKey("css", "label[for='change-account-type-member']"),
      selectorKey("css", "button[data-qa='change_account_type_save_btn'][aria-label='Save']"),
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']")
    ]);
  });

  it("fails activation safely when account type modal appears without a Save button", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Deactivated", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_activate']"),
        selectorKey("css", "label[for='change-account-type-member']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: false });

    await expect(connector.activateUserInWorkspace({
      email: "target@example.com"
    })).rejects.toMatchObject({
      name: "SlackConnectorError",
      code: SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged,
      details: {
        step: "save_account_type"
      }
    } satisfies Partial<SlackConnectorError>);
  });

  it("does not click Activate account during activation dry run", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Deactivated", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']"),
        selectorKey("css", "button[data-qa='ws-members-action_activate']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page, { dryRun: true });

    await expect(connector.activateUserInWorkspace({
      email: "target@example.com"
    })).resolves.toEqual({
      provider: "slack",
      mode: "browser",
      operation: "workspace_activate",
      email: "target@example.com",
      activated: false,
      alreadyActive: false,
      notFound: false,
      dryRun: true,
      message: "Slack browser activate dry run verified the member email and found the Activate account action without clicking it."
    });
    expect(page.clicks).toEqual([
      selectorKey("css", "[data-qa-id='U123'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']")
    ]);
  });

  it("treats an active workspace member as idempotently already activated", async () => {
    const page = makePage({
      rows: [
        { slackUserId: "U123", email: "target@example.com", status: "Active", visible: true }
      ],
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']")
      ],
      actionButtonCounts: new Map([["U123", 1]])
    });
    const connector = makeConnector(page);

    await expect(connector.activateUserInWorkspace({
      email: "target@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      operation: "workspace_activate",
      email: "target@example.com",
      activated: true,
      alreadyActive: true,
      notFound: false
    });
    expect(page.clicks).toEqual([]);
  });

  it("returns notFound when activation cannot find a workspace member", async () => {
    const page = makePage({
      visibleSelectors: [
        selectorKey("css", "input[data-qa='workspace-members__table-header-search_input']")
      ]
    });
    const connector = makeConnector(page);

    await expect(connector.activateUserInWorkspace({
      email: "missing@example.com"
    })).resolves.toMatchObject({
      provider: "slack",
      mode: "browser",
      operation: "workspace_activate",
      email: "missing@example.com",
      activated: false,
      alreadyActive: false,
      notFound: true
    });
    expect(page.clicks).toEqual([]);
  });
});

function makeConnector(
  page: FakeSlackBrowserWorkspaceRevokePage,
  options: {
    dryRun?: boolean;
  } = {}
): SlackBrowserWorkspaceRevokeConnector {
  return new SlackBrowserWorkspaceRevokeConnector({
    workspaceUrl: "https://example.slack.com",
    profileDir: "/tmp/slack-browser-profile",
    dryRun: options.dryRun ?? true,
    browserClient: makeBrowserClient(page)
  });
}

function makeBrowserClient(page: FakeSlackBrowserWorkspaceRevokePage): SlackBrowserWorkspaceRevokeClient {
  return {
    launchPersistentContext: vi.fn(async () => new FakeSlackBrowserWorkspaceRevokeContext(page))
  };
}

function makePage(input: {
  currentUrl?: string;
  gotoUrl?: string;
  visibleSelectors?: string[];
  rows?: FakeSlackMemberRow[];
  actionButtonCounts?: Map<string, number>;
} = {}): FakeSlackBrowserWorkspaceRevokePage {
  return new FakeSlackBrowserWorkspaceRevokePage({
    currentUrl: input.currentUrl ?? "https://example.slack.com/client/T123/C123",
    gotoUrl: input.gotoUrl,
    visibleSelectors: input.visibleSelectors ?? [],
    rows: input.rows ?? [],
    actionButtonCounts: input.actionButtonCounts ?? new Map()
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

type FakeSlackMemberRow = {
  slackUserId: string;
  email: string;
  status: string;
  visible: boolean;
};

class FakeSlackBrowserWorkspaceRevokeContext implements SlackBrowserWorkspaceRevokeContext {
  constructor(private readonly page: FakeSlackBrowserWorkspaceRevokePage) {}

  async newPage(): Promise<SlackBrowserWorkspaceRevokePage> {
    return this.page;
  }

  async close(): Promise<void> {}
}

class FakeSlackBrowserWorkspaceRevokePage implements SlackBrowserWorkspaceRevokePage {
  readonly gotoUrls: string[] = [];
  readonly clicks: string[] = [];
  readonly fills: Array<{ selector: string; value: string }> = [];
  readonly keyboardPresses: string[] = [];
  private currentUrl: string;
  private revokeInvitationSelected = false;

  constructor(private readonly input: {
    currentUrl: string;
    gotoUrl?: string;
    visibleSelectors: string[];
    rows: FakeSlackMemberRow[];
    actionButtonCounts: Map<string, number>;
  }) {
    this.currentUrl = input.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.gotoUrls.push(url);
    this.currentUrl = this.input.gotoUrl ?? url;
  }

  async bringToFront(): Promise<void> {}

  setDefaultTimeout(): void {}

  async waitForTimeout(): Promise<void> {}

  async keyboardInsertText(): Promise<void> {}

  async keyboardPress(key: string): Promise<void> {
    this.keyboardPresses.push(key);
  }

  url(): string {
    return this.currentUrl;
  }

  getByRole(role: string, options: { name: RegExp }): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this, selectorKey("role", role, options.name));
  }

  getByText(text: RegExp): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this, selectorKey("text", text));
  }

  getByLabel(text: RegExp): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this, selectorKey("label", text));
  }

  getByPlaceholder(text: RegExp): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this, selectorKey("placeholder", text));
  }

  locator(selector: string): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this, selectorKey("css", selector));
  }

  getRows(): FakeSlackMemberRow[] {
    return this.input.rows;
  }

  getActionButtonCount(slackUserId: string): number {
    return this.input.actionButtonCounts.get(slackUserId) ?? 0;
  }

  isSelectorVisible(selector: string, rowIndex?: number): boolean {
    if (selector === selectorKey("css", "[data-qa='workspace-members_table_data_table_row']") && rowIndex !== undefined) {
      return this.input.rows[rowIndex]?.visible ?? false;
    }

    const rowActionsMatch = selector.match(/^(?:css:)?\[data-qa-id='([^']+)'\]\[data-qa-column='workspace-members_table_row_actions'\] button\[data-qa='table_row_actions_button'\]$/u);

    if (rowActionsMatch) {
      return this.getActionButtonCount(rowActionsMatch[1]!) > 0;
    }

    return this.input.visibleSelectors.includes(selector);
  }

  recordClick(selector: string): void {
    this.clicks.push(selector);

    if (selector === selectorKey("css", "button[data-qa='ws-members-action_activate']")) {
      for (const row of this.input.rows) {
        if (row.status) {
          row.status = "Active";
        }
      }
    }

    if (/revoke invitation/iu.test(selector)) {
      this.revokeInvitationSelected = true;
    }

    if (selector === selectorKey("css", "button[data-qa='primary_action'][aria-label='Deactivate']")) {
      for (const row of this.input.rows) {
        if (
          this.revokeInvitationSelected ||
          /invited|invitation pending|pending invitation|invitation sent|not accepted/iu.test(row.status)
        ) {
          row.visible = false;
        }
      }
      this.revokeInvitationSelected = false;
    }
  }

  recordFill(selector: string, value: string): void {
    this.fills.push({ selector, value });
  }
}

class FakeSlackBrowserWorkspaceRevokeLocator implements SlackBrowserWorkspaceRevokeLocator {
  constructor(
    private readonly page: FakeSlackBrowserWorkspaceRevokePage,
    private readonly selector: string,
    private readonly rowIndex?: number
  ) {}

  first(): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this.page, this.selector, this.rowIndex);
  }

  nth(index: number): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this.page, this.selector, index);
  }

  locator(selector: string): SlackBrowserWorkspaceRevokeLocator {
    return new FakeSlackBrowserWorkspaceRevokeLocator(this.page, `${this.selector} >> ${selector}`, this.rowIndex);
  }

  async count(): Promise<number> {
    if (this.selector === selectorKey("css", "[data-qa='workspace-members_table_data_table_row']")) {
      return this.page.getRows().length;
    }

    const rowActionsMatch = this.selector.match(/^(?:css:)?\[data-qa-id='([^']+)'\]\[data-qa-column='workspace-members_table_row_actions'\] button\[data-qa='table_row_actions_button'\]$/u);

    if (rowActionsMatch) {
      return this.page.getActionButtonCount(rowActionsMatch[1]!);
    }

    return this.page.isSelectorVisible(this.selector) ? 1 : 0;
  }

  async getAttribute(name: string): Promise<string | null> {
    if (
      name === "data-qa-id" &&
      this.selector === selectorKey("css", "[data-qa='workspace-members_table_data_table_row']") &&
      this.rowIndex !== undefined
    ) {
      return this.page.getRows()[this.rowIndex]?.slackUserId ?? null;
    }

    return null;
  }

  async textContent(): Promise<string | null> {
    const emailMatch = this.selector.match(/^(?:css:)?\[data-qa-id='([^']+)'\]\[data-qa-column='workspace-members_table_email'\]$/u);

    if (emailMatch) {
      return this.page.getRows().find((row) => row.slackUserId === emailMatch[1] && row.email)?.email ?? "";
    }

    const statusMatch = this.selector.match(/^(?:css:)?\[data-qa-id='([^']+)'\]\[data-qa-column='workspace-members_table_account_status'\]$/u);

    if (statusMatch) {
      return this.page.getRows().find((row) => row.slackUserId === statusMatch[1] && row.status)?.status ?? "";
    }

    return "";
  }

  async isVisible(): Promise<boolean> {
    return this.page.isSelectorVisible(this.selector, this.rowIndex);
  }

  async click(): Promise<void> {
    this.page.recordClick(this.selector);
  }

  async focus(): Promise<void> {}

  async fill(value: string): Promise<void> {
    this.page.recordFill(this.selector, value);
  }

  async waitFor(): Promise<void> {
    if (!this.page.isSelectorVisible(this.selector, this.rowIndex)) {
      const error = new Error("Timeout 10000ms exceeded.");
      error.name = "TimeoutError";
      throw error;
    }
  }
}
