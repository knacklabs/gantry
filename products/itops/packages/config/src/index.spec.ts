import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("loads with Google Workspace disabled and no Google credentials", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      GOOGLE_WORKSPACE_ENABLED: "false"
    });

    expect(config.googleWorkspace).toEqual({
      enabled: false,
      domain: undefined,
      adminEmail: undefined,
      clientEmail: undefined,
      privateKey: undefined
    });
  });

  it("defaults Google Workspace to disabled when omitted", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops"
    });

    expect(config.googleWorkspace.enabled).toBe(false);
  });

  it("defaults Slack channel connector to mock when omitted", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops"
    });

    expect(config.slackChannelConnector).toEqual({
      mode: "mock",
      botToken: undefined
    });
  });

  it("allows Gmail email config to be omitted", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops"
    });

    expect(config.email).toEqual({
      itopsFrom: undefined,
      gmailClientEmail: undefined,
      gmailPrivateKey: undefined,
      gmailImpersonatedItopsEmail: undefined
    });
  });

  it("loads Gmail email config and normalizes escaped private key newlines", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      EMAIL_ITOPS_FROM: "itops@caw.tech",
      GMAIL_CLIENT_EMAIL: "service-account@example.iam.gserviceaccount.com",
      GMAIL_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----",
      GMAIL_IMPERSONATED_ITOPS_EMAIL: "itops@caw.tech"
    });

    expect(config.email).toEqual({
      itopsFrom: "itops@caw.tech",
      gmailClientEmail: "service-account@example.iam.gserviceaccount.com",
      gmailPrivateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      gmailImpersonatedItopsEmail: "itops@caw.tech"
    });
  });

  it("loads real Slack channel connector config when bot token is present", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      SLACK_CHANNEL_CONNECTOR_MODE: "real",
      SLACK_BOT_TOKEN: "xoxb-test-token"
    });

    expect(config.slackChannelConnector).toEqual({
      mode: "real",
      botToken: "xoxb-test-token"
    });
  });

  it("fails when real Slack channel connector is missing a bot token", () => {
    expect(() =>
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        SLACK_CHANNEL_CONNECTOR_MODE: "real"
      })
    ).toThrow(ZodError);
  });

  it("defaults Slack workspace invite to disabled when omitted", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops"
    });

    expect(config.slackWorkspaceInvite).toEqual({
      mode: "manual",
      adminToken: undefined,
      teamId: undefined,
      defaultInviteChannelIds: [],
      browserWorkspaceUrl: undefined,
      browserProfileDir: undefined,
      browserHeadless: true,
      browserDryRun: true,
      browserInviteTimeoutMs: 30_000,
      browserLoginMode: "manual",
      browserLoginEmail: undefined,
      browserLoginPassword: undefined
    });
  });

  it("loads automated Slack workspace invite config when admin token is present", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      SLACK_WORKSPACE_INVITE_MODE: "automated",
      SLACK_ADMIN_TOKEN: "xoxp-admin-token",
      SLACK_TEAM_ID: "T123",
      SLACK_DEFAULT_INVITE_CHANNEL_IDS: "C123, C999"
    });

    expect(config.slackWorkspaceInvite).toMatchObject({
      mode: "automated",
      adminToken: "xoxp-admin-token",
      teamId: "T123",
      defaultInviteChannelIds: ["C123", "C999"]
    });
  });

  it("fails when automated Slack workspace invite is missing an admin token", () => {
    expect(() =>
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        SLACK_WORKSPACE_INVITE_MODE: "automated"
      })
    ).toThrow(ZodError);
  });

  it("loads browser Slack workspace invite config with browser defaults", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      SLACK_WORKSPACE_INVITE_MODE: "browser",
      SLACK_BROWSER_WORKSPACE_URL: "https://example.slack.com",
      SLACK_BROWSER_PROFILE_DIR: "/var/lib/itops/slack-browser-profile"
    });

    expect(config.slackWorkspaceInvite).toMatchObject({
      mode: "browser",
      browserWorkspaceUrl: "https://example.slack.com",
      browserProfileDir: "/var/lib/itops/slack-browser-profile",
      browserHeadless: true,
      browserDryRun: true,
      browserInviteTimeoutMs: 30_000,
      browserLoginMode: "manual",
      browserLoginEmail: undefined,
      browserLoginPassword: undefined
    });
  });

  it("loads browser Slack workspace invite with automated Google SSO login credentials", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      SLACK_WORKSPACE_INVITE_MODE: "browser",
      SLACK_BROWSER_WORKSPACE_URL: "https://example.slack.com",
      SLACK_BROWSER_PROFILE_DIR: "/var/lib/itops/slack-browser-profile",
      SLACK_BROWSER_HEADLESS: "false",
      SLACK_BROWSER_DRY_RUN: "false",
      SLACK_BROWSER_INVITE_TIMEOUT_MS: "45000",
      SLACK_BROWSER_LOGIN_MODE: "google_sso",
      SLACK_BROWSER_LOGIN_EMAIL: "admin@example.com",
      SLACK_BROWSER_LOGIN_PASSWORD: "secret-password"
    });

    expect(config.slackWorkspaceInvite).toMatchObject({
      mode: "browser",
      browserHeadless: false,
      browserDryRun: false,
      browserInviteTimeoutMs: 45_000,
      browserLoginMode: "google_sso",
      browserLoginEmail: "admin@example.com",
      browserLoginPassword: "secret-password"
    });
  });

  it("fails when automated browser Google SSO login is missing credentials", () => {
    expect(() =>
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        SLACK_WORKSPACE_INVITE_MODE: "browser",
        SLACK_BROWSER_WORKSPACE_URL: "https://example.slack.com",
        SLACK_BROWSER_PROFILE_DIR: "/var/lib/itops/slack-browser-profile",
        SLACK_BROWSER_LOGIN_MODE: "google_sso",
        SLACK_BROWSER_LOGIN_EMAIL: "admin@example.com"
      })
    ).toThrow(ZodError);
  });

  it("fails when browser Slack workspace invite is missing required browser config", () => {
    expect(() =>
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        SLACK_WORKSPACE_INVITE_MODE: "browser"
      })
    ).toThrow(ZodError);
  });

  it("does not include browser login password values in validation messages", () => {
    try {
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        SLACK_WORKSPACE_INVITE_MODE: "browser",
        SLACK_BROWSER_WORKSPACE_URL: "not-a-url",
        SLACK_BROWSER_PROFILE_DIR: "/var/lib/itops/slack-browser-profile",
        SLACK_BROWSER_LOGIN_MODE: "google_sso",
        SLACK_BROWSER_LOGIN_EMAIL: "admin@example.com",
        SLACK_BROWSER_LOGIN_PASSWORD: "super-secret-password"
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(String(error)).not.toContain("super-secret-password");
      return;
    }

    throw new Error("Expected loadConfig to reject invalid browser workspace URL.");
  });

  it("defaults approval policy to disabled and self approval to false when omitted", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops"
    });

    expect(config.approvalPolicy).toEqual({
      enabled: false,
      approverExternalUserIds: [],
      allowSelfApproval: false
    });
  });

  it("loads enabled approval policy and normalizes approver ids from comma-separated env", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      ITOPS_APPROVAL_POLICY_ENABLED: "true",
      ITOPS_APPROVER_EXTERNAL_USER_IDS: " slack:U123, ,slack:U999 ",
      ITOPS_ALLOW_SELF_APPROVAL: "true"
    });

    expect(config.approvalPolicy).toEqual({
      enabled: true,
      approverExternalUserIds: ["slack:U123", "slack:U999"],
      allowSelfApproval: true
    });
  });

  it("fails when approval policy is enabled without approver ids", () => {
    expect(() =>
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        ITOPS_APPROVAL_POLICY_ENABLED: "true",
        ITOPS_APPROVER_EXTERNAL_USER_IDS: " , "
      })
    ).toThrow(ZodError);
  });

  it("does not include approval allowlist values in validation messages", () => {
    try {
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        ITOPS_APPROVAL_POLICY_ENABLED: "true",
        ITOPS_APPROVER_EXTERNAL_USER_IDS: ""
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(String(error)).not.toContain("slack:U123");
      expect(String(error)).not.toContain("slack:U999");
      return;
    }

    throw new Error("Expected loadConfig to reject missing approver ids.");
  });

  it("defaults the IT Ops API host to localhost", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops"
    });

    expect(config.itopsApiHost).toBe("127.0.0.1");
    expect(config.itopsApiPort).toBe(4000);
  });

  it("fails when Google Workspace is enabled without required credentials", () => {
    expect(() =>
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        GOOGLE_WORKSPACE_ENABLED: "true"
      })
    ).toThrow(ZodError);
  });

  it("loads enabled Google Workspace config and normalizes private key newlines", () => {
    const config = loadConfig({
      ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
      GOOGLE_WORKSPACE_ENABLED: "true",
      GOOGLE_WORKSPACE_DOMAIN: "company.com",
      GOOGLE_WORKSPACE_ADMIN_EMAIL: "admin@company.com",
      GOOGLE_WORKSPACE_CLIENT_EMAIL: "service-account@project.iam.gserviceaccount.com",
      GOOGLE_WORKSPACE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc123\\n-----END PRIVATE KEY-----\\n"
    });

    expect(config.googleWorkspace).toEqual({
      enabled: true,
      domain: "company.com",
      adminEmail: "admin@company.com",
      clientEmail: "service-account@project.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n"
    });
  });

  it("does not include private key values in validation messages", () => {
    try {
      loadConfig({
        ITOPS_DATABASE_URL: "postgresql://user:password@localhost:5432/itops",
        GOOGLE_WORKSPACE_ENABLED: "true",
        GOOGLE_WORKSPACE_DOMAIN: "company.com",
        GOOGLE_WORKSPACE_ADMIN_EMAIL: "admin@company.com",
        GOOGLE_WORKSPACE_CLIENT_EMAIL: "service-account@project.iam.gserviceaccount.com",
        GOOGLE_WORKSPACE_PRIVATE_KEY: ""
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(String(error)).not.toContain("abc123");
      expect(String(error)).not.toContain("PRIVATE KEY-----");
      return;
    }

    throw new Error("Expected loadConfig to reject missing private key.");
  });
});
