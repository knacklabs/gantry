import { z } from "zod";

export { loadEnvFiles } from "./load-env.js";

const optionalEnvString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional()
);

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  return value;
}, z.boolean());

const commaSeparatedEnvList = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}, z.array(z.string().trim().min(1)).default([]));

const slackChannelConnectorMode = z.enum(["mock", "real"]);
const slackWorkspaceInviteMode = z.enum(["manual", "automated", "browser"]);
const slackBrowserLoginMode = z.enum(["manual", "google_sso"]);

const configSchema = z.object({
  nodeEnv: z.string().default("development"),
  itopsApiHost: z.string().trim().min(1).default("127.0.0.1"),
  itopsApiPort: z.coerce.number().int().positive().default(4000),
  itopsToolBridgePort: z.coerce.number().int().positive().default(4100),
  itopsDatabaseUrl: z.string().url(),
  itopsApiBaseUrl: z.string().url().default("http://127.0.0.1:4000"),
  gantryControlUrl: z.string().url().default("http://127.0.0.1:8787"),
  googleWorkspace: z
    .object({
      enabled: envBoolean.default(false),
      domain: optionalEnvString,
      adminEmail: optionalEnvString,
      clientEmail: optionalEnvString,
      privateKey: optionalEnvString.transform((value) => value?.replace(/\\n/gu, "\n"))
    })
    .superRefine((value, ctx) => {
      if (!value.enabled) {
        return;
      }

      const requiredFields: Array<keyof typeof value> = ["domain", "adminEmail", "clientEmail", "privateKey"];

      for (const field of requiredFields) {
        if (!value[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `GOOGLE_WORKSPACE_${toEnvSuffix(field)} is required when GOOGLE_WORKSPACE_ENABLED=true.`
          });
        }
      }
    }),
  slackChannelConnector: z
    .object({
      mode: slackChannelConnectorMode.default("mock"),
      botToken: optionalEnvString
    })
    .superRefine((value, ctx) => {
      if (value.mode === "real" && !value.botToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["botToken"],
          message: "SLACK_BOT_TOKEN is required when SLACK_CHANNEL_CONNECTOR_MODE=real."
        });
      }
    }),
  slackWorkspaceInvite: z
    .object({
      mode: slackWorkspaceInviteMode.default("manual"),
      adminToken: optionalEnvString,
      teamId: optionalEnvString,
      defaultInviteChannelIds: commaSeparatedEnvList,
      browserWorkspaceUrl: optionalEnvString.pipe(z.string().url().optional()),
      browserProfileDir: optionalEnvString,
      browserHeadless: envBoolean.default(true),
      browserDryRun: envBoolean.default(true),
      browserInviteTimeoutMs: z.coerce.number().int().positive().default(30_000),
      browserLoginMode: slackBrowserLoginMode.default("manual"),
      browserLoginEmail: optionalEnvString,
      browserLoginPassword: optionalEnvString
    })
    .superRefine((value, ctx) => {
      if (value.mode === "automated" && !value.adminToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adminToken"],
          message: "SLACK_ADMIN_TOKEN is required when SLACK_WORKSPACE_INVITE_MODE=automated."
        });
      }

      if (value.mode !== "browser") {
        return;
      }

      if (!value.browserWorkspaceUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["browserWorkspaceUrl"],
          message: "SLACK_BROWSER_WORKSPACE_URL is required when SLACK_WORKSPACE_INVITE_MODE=browser."
        });
      }

      if (!value.browserProfileDir) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["browserProfileDir"],
          message: "SLACK_BROWSER_PROFILE_DIR is required when SLACK_WORKSPACE_INVITE_MODE=browser."
        });
      }

      if (value.browserLoginMode === "google_sso") {
        if (!value.browserLoginEmail) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["browserLoginEmail"],
            message: "SLACK_BROWSER_LOGIN_EMAIL is required when SLACK_BROWSER_LOGIN_MODE=google_sso."
          });
        }

        if (!value.browserLoginPassword) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["browserLoginPassword"],
            message: "SLACK_BROWSER_LOGIN_PASSWORD is required when SLACK_BROWSER_LOGIN_MODE=google_sso."
          });
        }
      }
    }),
  email: z.object({
    itopsFrom: optionalEnvString,
    gmailClientEmail: optionalEnvString,
    gmailPrivateKey: optionalEnvString.transform((value) => value?.replace(/\\n/gu, "\n")),
    gmailImpersonatedItopsEmail: optionalEnvString
  }),
  approvalPolicy: z
    .object({
      enabled: envBoolean.default(false),
      approverExternalUserIds: commaSeparatedEnvList,
      allowSelfApproval: envBoolean.default(false)
    })
    .superRefine((value, ctx) => {
      if (value.enabled && value.approverExternalUserIds.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approverExternalUserIds"],
          message: "ITOPS_APPROVER_EXTERNAL_USER_IDS is required when ITOPS_APPROVAL_POLICY_ENABLED=true."
        });
      }
    })
});

export type AppConfig = z.infer<typeof configSchema>;
export type SlackChannelConnectorMode = AppConfig["slackChannelConnector"]["mode"];
export type SlackWorkspaceInviteMode = AppConfig["slackWorkspaceInvite"]["mode"];
export type SlackBrowserLoginMode = AppConfig["slackWorkspaceInvite"]["browserLoginMode"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    nodeEnv: env.NODE_ENV,
    itopsApiHost: env.ITOPS_API_HOST,
    itopsApiPort: env.ITOPS_API_PORT,
    itopsToolBridgePort: env.ITOPS_TOOL_BRIDGE_PORT,
    itopsDatabaseUrl: env.ITOPS_DATABASE_URL,
    itopsApiBaseUrl: env.ITOPS_API_BASE_URL,
    gantryControlUrl: env.GANTRY_CONTROL_URL,
    googleWorkspace: {
      enabled: env.GOOGLE_WORKSPACE_ENABLED,
      domain: env.GOOGLE_WORKSPACE_DOMAIN,
      adminEmail: env.GOOGLE_WORKSPACE_ADMIN_EMAIL,
      clientEmail: env.GOOGLE_WORKSPACE_CLIENT_EMAIL,
      privateKey: env.GOOGLE_WORKSPACE_PRIVATE_KEY
    },
    slackChannelConnector: {
      mode: env.SLACK_CHANNEL_CONNECTOR_MODE,
      botToken: env.SLACK_BOT_TOKEN
    },
    slackWorkspaceInvite: {
      mode: env.SLACK_WORKSPACE_INVITE_MODE,
      adminToken: env.SLACK_ADMIN_TOKEN,
      teamId: env.SLACK_TEAM_ID,
      defaultInviteChannelIds: env.SLACK_DEFAULT_INVITE_CHANNEL_IDS,
      browserWorkspaceUrl: env.SLACK_BROWSER_WORKSPACE_URL,
      browserProfileDir: env.SLACK_BROWSER_PROFILE_DIR,
      browserHeadless: env.SLACK_BROWSER_HEADLESS,
      browserDryRun: env.SLACK_BROWSER_DRY_RUN,
      browserInviteTimeoutMs: env.SLACK_BROWSER_INVITE_TIMEOUT_MS,
      browserLoginMode: env.SLACK_BROWSER_LOGIN_MODE,
      browserLoginEmail: env.SLACK_BROWSER_LOGIN_EMAIL,
      browserLoginPassword: env.SLACK_BROWSER_LOGIN_PASSWORD
    },
    email: {
      itopsFrom: env.EMAIL_ITOPS_FROM,
      gmailClientEmail: env.GMAIL_CLIENT_EMAIL,
      gmailPrivateKey: env.GMAIL_PRIVATE_KEY,
      gmailImpersonatedItopsEmail: env.GMAIL_IMPERSONATED_ITOPS_EMAIL
    },
    approvalPolicy: {
      enabled: env.ITOPS_APPROVAL_POLICY_ENABLED,
      approverExternalUserIds: env.ITOPS_APPROVER_EXTERNAL_USER_IDS,
      allowSelfApproval: env.ITOPS_ALLOW_SELF_APPROVAL
    }
  });
}

function toEnvSuffix(field: string): string {
  return field.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase();
}
