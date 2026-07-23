import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

import {
  SLACK_CONNECTOR_ERROR_CODE,
  SLACK_PROVIDER,
  SlackConnectorError,
  type ActivateSlackWorkspaceUserInput,
  type ActivateSlackWorkspaceUserResult,
  type RevokeSlackWorkspaceUserInput,
  type RevokeSlackWorkspaceUserResult
} from "./slack.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const SHORT_SELECTOR_TIMEOUT_MS = 1_000;
const MEMBER_SEARCH_SETTLE_MS = 4_000;

const SELECTORS = {
  loginText: [
    /sign in to slack/i,
    /sign in with google/i,
    /google apps account/i,
    /continue with google/i,
    /check your email/i,
    /enter your code/i,
    /two-factor/i,
    /single sign-on/i
  ],
  searchInputs: [
    { css: "input[data-qa='workspace-members__table-header-search_input']" },
    { role: "searchbox", name: /filter by name, email, or id/i },
    { placeholder: /filter by name, email, or id/i },
    { placeholder: /search members/i },
    { placeholder: /search by name or email/i },
    { label: /search members/i },
    { role: "searchbox", name: /search/i },
    { role: "textbox", name: /search/i },
    { css: "input[type='search']" },
    { css: "input[placeholder*='Search']" }
  ],
  deactivateActions: [
    { css: "button[data-qa='ws-members-action_deactivate']" },
    { css: "[data-qa='ws-members-action_deactivate-wrapper'] button" },
    { role: "menuitem", name: /deactivate account/i },
    { role: "menuitem", name: /deactivate/i },
    { role: "button", name: /deactivate account/i },
    { text: /deactivate account/i },
    { text: /deactivate/i }
  ],
  revokeInvitationActions: [
    { css: "button[data-qa='ws-members-action_deactivate']" },
    { css: "[data-qa='ws-members-action_deactivate-wrapper'] button" },
    { role: "menuitem", name: /revoke invitation/i },
    { role: "button", name: /revoke invitation/i },
    { text: /revoke invitation/i }
  ],
  revokeInvitationTextActions: [
    { role: "menuitem", name: /revoke invitation/i },
    { role: "button", name: /revoke invitation/i },
    { text: /revoke invitation/i }
  ],
  activateActions: [
    { css: "button[data-qa='ws-members-action_activate']" },
    { css: "[data-qa='ws-members-action_activate-wrapper'] button" },
    { role: "menuitem", name: /activate account/i },
    { role: "button", name: /activate account/i },
    { text: /activate account/i }
  ],
  confirmButtons: [
    { css: "button[data-qa='primary_action'][aria-label='Deactivate']" },
    { css: "[data-qa='ask_admin_modal'] button[data-qa='primary_action']" },
    { role: "button", name: /deactivate/i },
    { role: "button", name: /confirm/i },
    { role: "button", name: /remove/i },
    { css: "button:has-text('Deactivate')" },
    { css: "button:has-text('Confirm')" }
  ],
  confirmRevokeInvitationButtons: [
    { css: "button[data-qa='primary_action'][aria-label='Revoke invitation']" },
    { css: "button[data-qa='primary_action'][aria-label='Deactivate']" },
    { css: "[data-qa='ask_admin_modal'] button[data-qa='primary_action']" },
    { css: "[role='dialog'] button:has-text('Revoke invitation')" },
    { css: "[role='dialog'] button:has-text('Deactivate')" },
    { role: "button", name: /revoke invitation/i },
    { role: "button", name: /deactivate/i },
    { role: "button", name: /confirm/i },
    { css: "button:has-text('Deactivate')" },
    { css: "button:has-text('Confirm')" }
  ],
  confirmActivateButtons: [
    { css: "button[data-qa='primary_action'][aria-label='Activate']" },
    { css: "[data-qa='ask_admin_modal'] button[data-qa='primary_action']" },
    { css: "[role='dialog'] button:has-text('Activate')" },
    { css: "[role='dialog'] button:has-text('Confirm')" }
  ],
  accountTypeMemberOptions: [
    { css: "label[for='change-account-type-member']" },
    { css: "input#change-account-type-member" },
    { role: "radio", name: /regular member/i },
    { text: /regular member/i }
  ],
  accountTypeSaveButtons: [
    { css: "button[data-qa='change_account_type_save_btn'][aria-label='Save']" },
    { css: "button[data-qa='change_account_type_save_btn']" },
    { css: "[role='dialog'] button:has-text('Save')" },
    { role: "button", name: /^save$/i }
  ],
  tableRows: "[data-qa='workspace-members_table_data_table_row']",
  emailCellForUser: (slackUserId: string) =>
    `[data-qa-id='${cssEscape(slackUserId)}'][data-qa-column='workspace-members_table_email']`,
  statusCellForUser: (slackUserId: string) =>
    `[data-qa-id='${cssEscape(slackUserId)}'][data-qa-column='workspace-members_table_account_status']`,
  rowActionsButtonForUser: (slackUserId: string) =>
    `[data-qa-id='${cssEscape(slackUserId)}'][data-qa-column='workspace-members_table_row_actions'] button[data-qa='table_row_actions_button']`
} as const;

export type SlackBrowserWorkspaceRevokeConnectorConfig = {
  workspaceUrl: string;
  profileDir: string;
  dryRun?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  browserClient?: SlackBrowserWorkspaceRevokeClient;
};

export type SlackBrowserWorkspaceRevokeClient = {
  launchPersistentContext(input: {
    profileDir: string;
    headless: boolean;
    timeoutMs: number;
  }): Promise<SlackBrowserWorkspaceRevokeContext>;
};

export type SlackBrowserWorkspaceRevokeContext = {
  newPage(): Promise<SlackBrowserWorkspaceRevokePage>;
  close(): Promise<void>;
};

export type SlackBrowserWorkspaceRevokePage = {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  bringToFront(): Promise<void>;
  setDefaultTimeout(timeoutMs: number): void;
  waitForTimeout(timeoutMs: number): Promise<void>;
  keyboardInsertText(text: string): Promise<void>;
  keyboardPress(key: string): Promise<void>;
  url(): string;
  getByRole(role: string, options: { name: RegExp }): SlackBrowserWorkspaceRevokeLocator;
  getByText(text: RegExp): SlackBrowserWorkspaceRevokeLocator;
  getByLabel(text: RegExp): SlackBrowserWorkspaceRevokeLocator;
  getByPlaceholder(text: RegExp): SlackBrowserWorkspaceRevokeLocator;
  locator(selector: string): SlackBrowserWorkspaceRevokeLocator;
};

export type SlackBrowserWorkspaceRevokeLocator = {
  first(): SlackBrowserWorkspaceRevokeLocator;
  nth(index: number): SlackBrowserWorkspaceRevokeLocator;
  locator(selector: string): SlackBrowserWorkspaceRevokeLocator;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  focus(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
};

type SelectorCandidate =
  | { role: string; name: RegExp }
  | { text: RegExp }
  | { label: RegExp }
  | { placeholder: RegExp }
  | { css: string };

type SelectorStep =
  | "login_check"
  | "member_search"
  | "member_row"
  | "member_actions"
  | "activate_action"
  | "confirm_activation"
  | "account_type_member"
  | "save_account_type"
  | "deactivate_action"
  | "confirm_deactivation"
  | "revoke_invitation_action"
  | "confirm_revoke_invitation"
  | "success_confirmation";

export class SlackBrowserWorkspaceRevokeConnector {
  private readonly workspaceUrl: string;
  private readonly profileDir: string;
  private readonly dryRun: boolean;
  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly browserClient: SlackBrowserWorkspaceRevokeClient;

  constructor(config: SlackBrowserWorkspaceRevokeConnectorConfig) {
    this.workspaceUrl = validateWorkspaceUrl(config.workspaceUrl);
    this.profileDir = config.profileDir;
    this.dryRun = config.dryRun ?? true;
    this.headless = config.headless ?? true;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.browserClient = config.browserClient ?? new PlaywrightSlackBrowserWorkspaceRevokeClient();
  }

  async revokeUserFromWorkspace(input: RevokeSlackWorkspaceUserInput): Promise<RevokeSlackWorkspaceUserResult> {
    const email = normalizeEmail(input.email);
    let context: SlackBrowserWorkspaceRevokeContext | undefined;

    try {
      context = await this.browserClient.launchPersistentContext({
        profileDir: this.profileDir,
        headless: this.headless,
        timeoutMs: this.timeoutMs
      });

      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(buildSlackAdminMembersUrl(this.workspaceUrl), {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
      await page.bringToFront();
      await this.ensureAdminMembersPage(page);
      await this.assertLoggedIn(page);

      const searchInput = await fillFirstVisible(page, SELECTORS.searchInputs, email, "member_search", this.timeoutMs);
      await searchInput.focus({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
      await page.keyboardPress("Enter");
      await page.waitForTimeout(MEMBER_SEARCH_SETTLE_MS);

      const targetMember = await resolveUniqueMember(page, email);

      if (!targetMember) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_revoke",
          email,
          revoked: true,
          alreadyInactive: true,
          dryRun: this.dryRun,
          message: "Slack workspace member was not found or is already inactive."
        };
      }

      await targetMember.actionsButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
      const revokeInvitationAction = await findFirstVisible(
        page,
        SELECTORS.revokeInvitationTextActions,
        SHORT_SELECTOR_TIMEOUT_MS
      );

      if (targetMember.inactive && !revokeInvitationAction) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_revoke",
          email,
          revoked: true,
          alreadyInactive: true,
          dryRun: this.dryRun,
          message: "Slack workspace member is already inactive."
        };
      }

      if (targetMember.invited || revokeInvitationAction) {
        if (revokeInvitationAction) {
          await revokeInvitationAction.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
        } else {
          await clickFirstVisible(page, SELECTORS.revokeInvitationActions, "revoke_invitation_action");
        }

        const confirmButton = await findFirstVisible(page, SELECTORS.confirmRevokeInvitationButtons, this.timeoutMs);

        if (!confirmButton) {
          throw slackBrowserError({
            code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
            message: "Slack workspace revoke invitation confirmation button selector was not found.",
            step: "confirm_revoke_invitation",
            currentUrl: page.url()
          });
        }

        if (this.dryRun) {
          return {
            provider: SLACK_PROVIDER,
            mode: "browser",
            operation: "workspace_revoke",
            email,
            revoked: false,
            alreadyInactive: false,
            dryRun: true,
            message: "Slack browser revoke dry run verified the pending invitation and reached the revoke invitation confirmation modal without confirming."
          };
        }

        await confirmButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
        await page.waitForTimeout(MEMBER_SEARCH_SETTLE_MS);
        const revokedInvitationMember = await this.refetchMemberFromAdminMembersPage(page, email);

        if (revokedInvitationMember && !revokedInvitationMember.inactive) {
          throw slackBrowserError({
            code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed,
            message: "Slack workspace revoke could not verify that the pending invitation was removed after confirmation.",
            step: "success_confirmation",
            currentUrl: page.url()
          });
        }

        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_revoke",
          email,
          revoked: true,
          alreadyInactive: false,
          dryRun: false,
          message: "Slack workspace invitation was revoked."
        };
      }

      await clickFirstVisible(page, SELECTORS.deactivateActions, "deactivate_action");
      const confirmButton = await findFirstVisible(page, SELECTORS.confirmButtons, this.timeoutMs);

      if (!confirmButton) {
        throw slackBrowserError({
          code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
          message: "Slack workspace revoke confirmation button selector was not found.",
          step: "confirm_deactivation",
          currentUrl: page.url()
        });
      }

      if (this.dryRun) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_revoke",
          email,
          revoked: false,
          alreadyInactive: false,
          dryRun: true,
          message: "Slack browser revoke dry run verified the member email and reached the deactivate confirmation modal without confirming."
        };
      }

      await confirmButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
      await page.waitForTimeout(MEMBER_SEARCH_SETTLE_MS);
      const deactivatedMember = await this.refetchMemberFromAdminMembersPage(page, email);

      if (!deactivatedMember) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_revoke",
          email,
          revoked: true,
          alreadyInactive: false,
          dryRun: false,
          message: "Slack workspace member was deactivated."
        };
      }

      if (!deactivatedMember.inactive) {
        await verifyActivateActionVisible(page, deactivatedMember);
      }

      return {
        provider: SLACK_PROVIDER,
        mode: "browser",
        operation: "workspace_revoke",
        email,
        revoked: true,
        alreadyInactive: false,
        dryRun: false,
        message: "Slack workspace member was deactivated."
      };
    } catch (error) {
      throw normalizeSlackBrowserRevokeError(error);
    } finally {
      await context?.close();
    }
  }

  private async refetchMemberFromAdminMembersPage(
    page: SlackBrowserWorkspaceRevokePage,
    email: string
  ): Promise<ResolvedSlackMember | null> {
    await page.goto(buildSlackAdminMembersUrl(this.workspaceUrl), {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs
    });
    await page.bringToFront();
    await this.ensureAdminMembersPage(page);
    await this.assertLoggedIn(page);
    return searchForUniqueMember(page, email, this.timeoutMs);
  }

  async activateUserInWorkspace(input: ActivateSlackWorkspaceUserInput): Promise<ActivateSlackWorkspaceUserResult> {
    const email = normalizeEmail(input.email);
    let context: SlackBrowserWorkspaceRevokeContext | undefined;

    try {
      context = await this.browserClient.launchPersistentContext({
        profileDir: this.profileDir,
        headless: this.headless,
        timeoutMs: this.timeoutMs
      });

      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(buildSlackAdminMembersUrl(this.workspaceUrl), {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
      await page.bringToFront();
      await this.ensureAdminMembersPage(page);
      await this.assertLoggedIn(page);

      const targetMember = await searchForUniqueMember(page, email, this.timeoutMs);

      if (!targetMember) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_activate",
          email,
          activated: false,
          alreadyActive: false,
          notFound: true,
          dryRun: this.dryRun,
          message: "Slack workspace member was not found."
        };
      }

      if (!targetMember.inactive) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_activate",
          email,
          activated: true,
          alreadyActive: true,
          notFound: false,
          dryRun: this.dryRun,
          message: "Slack workspace member is already active."
        };
      }

      await targetMember.actionsButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
      const activateButton = await findFirstVisible(page, SELECTORS.activateActions, this.timeoutMs);

      if (!activateButton) {
        throw slackBrowserError({
          code: SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged,
          message: "Slack workspace activate action selector was not found.",
          step: "activate_action",
          currentUrl: page.url()
        });
      }

      if (this.dryRun) {
        return {
          provider: SLACK_PROVIDER,
          mode: "browser",
          operation: "workspace_activate",
          email,
          activated: false,
          alreadyActive: false,
          notFound: false,
          dryRun: true,
          message: "Slack browser activate dry run verified the member email and found the Activate account action without clicking it."
        };
      }

      await activateButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
      await clickOptionalFirstVisible(page, SELECTORS.confirmActivateButtons, "confirm_activation", 3_000);
      await completeAccountTypeModalIfVisible(page);
      await page.waitForTimeout(6_000);
      const activatedMember = await searchForUniqueMember(page, email, this.timeoutMs);

      if (!activatedMember) {
        throw slackBrowserError({
          code: SLACK_CONNECTOR_ERROR_CODE.browserActivateFailed,
          message: "Slack workspace activate could not verify the member after activation.",
          step: "success_confirmation",
          currentUrl: page.url()
        });
      }

      await verifyDeactivateActionVisible(page, activatedMember);

      return {
        provider: SLACK_PROVIDER,
        mode: "browser",
        operation: "workspace_activate",
        email,
        activated: true,
        alreadyActive: false,
        notFound: false,
        dryRun: false,
        message: "Slack workspace member was activated."
      };
    } catch (error) {
      throw normalizeSlackBrowserRevokeError(error);
    } finally {
      await context?.close();
    }
  }

  private async assertLoggedIn(page: SlackBrowserWorkspaceRevokePage): Promise<void> {
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

  private async ensureAdminMembersPage(page: SlackBrowserWorkspaceRevokePage): Promise<void> {
    const adminMembersUrl = buildSlackAdminMembersUrl(this.workspaceUrl);
    const currentUrl = page.url();

    if (isSlackClientUrl(currentUrl)) {
      await page.goto(adminMembersUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      await page.bringToFront();
    }
  }
}

async function completeAccountTypeModalIfVisible(page: SlackBrowserWorkspaceRevokePage): Promise<void> {
  const memberOption = await findFirstVisible(page, SELECTORS.accountTypeMemberOptions, 15_000);

  if (!memberOption) {
    return;
  }

  await memberOption.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
  const saveButton = await findFirstVisible(page, SELECTORS.accountTypeSaveButtons, 10_000);

  if (!saveButton) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged,
      message: "Slack workspace activate account-type save button was not found.",
      step: "save_account_type",
      currentUrl: page.url()
    });
  }

  await saveButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
}

async function verifyDeactivateActionVisible(
  page: SlackBrowserWorkspaceRevokePage,
  member: ResolvedSlackMember
): Promise<void> {
  await member.actionsButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });

  if (!(await findFirstVisible(page, SELECTORS.deactivateActions, SHORT_SELECTOR_TIMEOUT_MS))) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserActivateFailed,
      message: "Slack workspace activate could not verify the Deactivate account menu item after activation.",
      step: "success_confirmation",
      currentUrl: page.url()
    });
  }
}

async function searchForUniqueMember(
  page: SlackBrowserWorkspaceRevokePage,
  email: string,
  timeoutMs: number
): Promise<ResolvedSlackMember | null> {
  const searchInput = await fillFirstVisible(page, SELECTORS.searchInputs, email, "member_search", timeoutMs);
  await searchInput.focus({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
  await page.keyboardPress("Enter");
  await page.waitForTimeout(MEMBER_SEARCH_SETTLE_MS);

  return resolveUniqueMember(page, email);
}

class PlaywrightSlackBrowserWorkspaceRevokeClient implements SlackBrowserWorkspaceRevokeClient {
  async launchPersistentContext(input: {
    profileDir: string;
    headless: boolean;
    timeoutMs: number;
  }): Promise<SlackBrowserWorkspaceRevokeContext> {
    const context = await chromium.launchPersistentContext(input.profileDir, {
      headless: input.headless,
      viewport: null,
      timeout: input.timeoutMs,
      args: [
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });

    return new PlaywrightSlackBrowserWorkspaceRevokeContext(context);
  }
}

class PlaywrightSlackBrowserWorkspaceRevokeContext implements SlackBrowserWorkspaceRevokeContext {
  constructor(private readonly context: BrowserContext) {}

  async newPage(): Promise<SlackBrowserWorkspaceRevokePage> {
    return new PlaywrightSlackBrowserWorkspaceRevokePage(await this.context.newPage());
  }

  close(): Promise<void> {
    return this.context.close();
  }
}

class PlaywrightSlackBrowserWorkspaceRevokePage implements SlackBrowserWorkspaceRevokePage {
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

  keyboardInsertText(text: string): Promise<void> {
    return this.page.keyboard.insertText(text);
  }

  keyboardPress(key: string): Promise<void> {
    return this.page.keyboard.press(key);
  }

  url(): string {
    return this.page.url();
  }

  getByRole(role: string, options: { name: RegExp }): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.page.getByRole(role as never, options));
  }

  getByText(text: RegExp): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.page.getByText(text));
  }

  getByLabel(text: RegExp): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.page.getByLabel(text));
  }

  getByPlaceholder(text: RegExp): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.page.getByPlaceholder(text));
  }

  locator(selector: string): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.page.locator(selector));
  }
}

class PlaywrightSlackBrowserWorkspaceRevokeLocator implements SlackBrowserWorkspaceRevokeLocator {
  constructor(private readonly wrappedLocator: Locator) {}

  first(): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.wrappedLocator.first());
  }

  nth(index: number): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.wrappedLocator.nth(index));
  }

  locator(selector: string): SlackBrowserWorkspaceRevokeLocator {
    return new PlaywrightSlackBrowserWorkspaceRevokeLocator(this.wrappedLocator.locator(selector));
  }

  count(): Promise<number> {
    return this.wrappedLocator.count();
  }

  getAttribute(name: string): Promise<string | null> {
    return this.wrappedLocator.getAttribute(name);
  }

  textContent(): Promise<string | null> {
    return this.wrappedLocator.textContent();
  }

  isVisible(options?: { timeout?: number }): Promise<boolean> {
    return this.wrappedLocator.isVisible(options);
  }

  click(options?: { timeout?: number; force?: boolean }): Promise<void> {
    return this.wrappedLocator.click(options);
  }

  focus(options?: { timeout?: number }): Promise<void> {
    return this.wrappedLocator.focus(options);
  }

  fill(value: string, options?: { timeout?: number }): Promise<void> {
    return this.wrappedLocator.fill(value, options);
  }

  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void> {
    return this.wrappedLocator.waitFor(options);
  }
}

type ResolvedSlackMember = {
  slackUserId: string;
  inactive: boolean;
  invited: boolean;
  actionsButton: SlackBrowserWorkspaceRevokeLocator;
};

async function resolveUniqueMember(
  page: SlackBrowserWorkspaceRevokePage,
  email: string
): Promise<ResolvedSlackMember | null> {
  const rows = page.locator(SELECTORS.tableRows);
  const visibleSlackUserIds = new Set<string>();
  const rowCount = await rows.count();

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);

    if (!(await isVisible(row))) {
      continue;
    }

    const slackUserId = await row.getAttribute("data-qa-id");

    if (slackUserId) {
      visibleSlackUserIds.add(slackUserId);
    }
  }

  if (visibleSlackUserIds.size === 0) {
    return null;
  }

  if (visibleSlackUserIds.size > 1) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      message: "Slack workspace revoke search returned multiple matching users.",
      step: "member_row",
      currentUrl: page.url()
    });
  }

  const [slackUserId] = visibleSlackUserIds;
  const emailCell = page.locator(SELECTORS.emailCellForUser(slackUserId)).first();
  const resolvedEmail = normalizeEmail(await getTextContent(emailCell));

  if (resolvedEmail !== email) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      message: "Slack workspace revoke search result email did not match the requested user.",
      step: "member_row",
      currentUrl: page.url()
    });
  }

  const statusCell = page.locator(SELECTORS.statusCellForUser(slackUserId)).first();
  const status = normalizeText(await getTextContent(statusCell));

  const actionsButton = page.locator(SELECTORS.rowActionsButtonForUser(slackUserId));
  const actionsButtonCount = await actionsButton.count();

  if (actionsButtonCount !== 1 || !(await isVisible(actionsButton.first()))) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      message: "Slack workspace revoke row-scoped actions button was not found.",
      step: "member_actions",
      currentUrl: page.url()
    });
  }

  return {
    slackUserId,
    inactive: isInactiveStatus(status),
    invited: isInvitedStatus(status),
    actionsButton: actionsButton.first()
  };
}

async function verifyActivateActionVisible(
  page: SlackBrowserWorkspaceRevokePage,
  member: ResolvedSlackMember
): Promise<void> {
  await member.actionsButton.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });

  if (await findFirstVisible(page, SELECTORS.activateActions, SHORT_SELECTOR_TIMEOUT_MS)) {
    return;
  }

  if (await findFirstVisible(page, SELECTORS.deactivateActions, SHORT_SELECTOR_TIMEOUT_MS)) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed,
      message: "Slack workspace revoke could not verify deactivation because the Deactivate account menu item is still available.",
      step: "success_confirmation",
      currentUrl: page.url()
    });
  }
}

async function clickOptionalFirstVisible(
  page: SlackBrowserWorkspaceRevokePage,
  candidates: readonly SelectorCandidate[],
  step: SelectorStep,
  timeoutMs = SHORT_SELECTOR_TIMEOUT_MS
): Promise<boolean> {
  const locator = await findFirstVisible(page, candidates, timeoutMs);

  if (!locator) {
    return false;
  }

  try {
    await locator.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
    return true;
  } catch {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserActivateUiChanged,
      message: "Slack workspace activate confirmation button could not be clicked.",
      step,
      currentUrl: page.url()
    });
  }
}

async function getTextContent(locator: SlackBrowserWorkspaceRevokeLocator): Promise<string> {
  try {
    return await locator.textContent() ?? "";
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function isInactiveStatus(status: string): boolean {
  return /\b(deactivated|inactive|disabled)\b/iu.test(status);
}

function isInvitedStatus(status: string): boolean {
  return /\b(invited|invitation pending|pending invitation|invitation sent|not accepted)\b/iu.test(status);
}

async function fillFirstVisible(
  page: SlackBrowserWorkspaceRevokePage,
  candidates: readonly SelectorCandidate[],
  value: string,
  step: SelectorStep,
  timeoutMs = SHORT_SELECTOR_TIMEOUT_MS
): Promise<SlackBrowserWorkspaceRevokeLocator> {
  const locator = await findFirstVisible(page, candidates, timeoutMs);

  if (!locator) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      message: "Slack workspace revoke search input selector was not found.",
      step,
      currentUrl: page.url()
    });
  }

  await locator.fill(value, { timeout: SHORT_SELECTOR_TIMEOUT_MS });
  return locator;
}

async function clickFirstVisible(
  page: SlackBrowserWorkspaceRevokePage,
  candidates: readonly SelectorCandidate[],
  step: SelectorStep
): Promise<void> {
  const locator = await findFirstVisible(page, candidates);

  if (!locator) {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeUiChanged,
      message: "Slack workspace revoke UI selector was not found.",
      step,
      currentUrl: page.url()
    });
  }

  await locator.click({ timeout: SHORT_SELECTOR_TIMEOUT_MS });
}

async function findFirstVisible(
  page: SlackBrowserWorkspaceRevokePage,
  candidates: readonly SelectorCandidate[],
  timeoutMs = SHORT_SELECTOR_TIMEOUT_MS
): Promise<SlackBrowserWorkspaceRevokeLocator | null> {
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

function locatorFor(
  page: SlackBrowserWorkspaceRevokePage,
  candidate: SelectorCandidate
): SlackBrowserWorkspaceRevokeLocator {
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

async function waitForVisible(locator: SlackBrowserWorkspaceRevokeLocator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function isVisible(
  locator: SlackBrowserWorkspaceRevokeLocator,
  timeoutMs = SHORT_SELECTOR_TIMEOUT_MS
): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: timeoutMs });
  } catch {
    return false;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateWorkspaceUrl(workspaceUrl: string): string {
  const url = new URL(workspaceUrl);

  if (url.protocol !== "https:") {
    throw slackBrowserError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserRevokeFailed,
      message: "Slack browser workspace URL must use https.",
      step: "login_check",
      currentUrl: workspaceUrl
    });
  }

  return url.toString();
}

function buildSlackAdminMembersUrl(workspaceUrl: string): string {
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

function normalizeSlackBrowserRevokeError(error: unknown): SlackConnectorError {
  if (error instanceof SlackConnectorError) {
    return error;
  }

  if (isTimeoutError(error)) {
    return new SlackConnectorError({
      code: SLACK_CONNECTOR_ERROR_CODE.browserTimeout,
      message: "Slack browser workspace revoke timed out.",
      cause: error
    });
  }

  return new SlackConnectorError({
    code: SLACK_CONNECTOR_ERROR_CODE.browserUnknown,
    message: "Slack browser workspace revoke failed unexpectedly.",
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

function cssEscape(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}
