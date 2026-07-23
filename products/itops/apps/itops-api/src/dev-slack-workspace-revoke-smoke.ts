import { loadConfig, loadEnvFiles } from "@itops/config";
import {
  SLACK_CONNECTOR_ERROR_CODE,
  SlackBrowserLoginConnector,
  SlackBrowserWorkspaceRevokeConnector,
  SlackConnectorError
} from "@itops/connectors";

type SmokeResult =
  | {
      ok: true;
      dryRun: boolean;
      email: string;
      loginResult?: Awaited<ReturnType<SlackBrowserLoginConnector["login"]>>;
      result: Awaited<ReturnType<SlackBrowserWorkspaceRevokeConnector["revokeUserFromWorkspace"]>>;
    }
  | {
      ok: false;
      dryRun: boolean;
      email: string;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };

type SafeSmokeError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

async function main(): Promise<void> {
  loadEnvFiles();

  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const email = normalizeEmail(args.find((arg) => !arg.startsWith("--")));

  if (!email) {
    throw new Error("Usage: pnpm --filter @itops/itops-api exec tsx src/dev-slack-workspace-revoke-smoke.ts <email> [--live]");
  }

  const config = loadConfig().slackWorkspaceInvite;

  if (config.mode !== "browser") {
    throw new Error("Slack workspace browser automation is not enabled.");
  }

  if (!config.browserWorkspaceUrl || !config.browserProfileDir) {
    throw new Error("Slack browser workspace URL and profile directory are required.");
  }

  const connector = new SlackBrowserWorkspaceRevokeConnector({
    workspaceUrl: config.browserWorkspaceUrl,
    profileDir: config.browserProfileDir,
    dryRun: !live,
    headless: config.browserHeadless,
    timeoutMs: config.browserInviteTimeoutMs
  });

  try {
    const result = await revokeWithLoginRecovery({
      connector,
      email,
      config
    });
    printResult({
      ok: true,
      dryRun: !live,
      email,
      loginResult: result.loginResult,
      result: result.revokeResult
    });
  } catch (error) {
    printResult({
      ok: false,
      dryRun: !live,
      email,
      error: normalizeSafeError(error)
    });
    process.exitCode = 1;
  }
}

async function revokeWithLoginRecovery(input: {
  connector: SlackBrowserWorkspaceRevokeConnector;
  email: string;
  config: ReturnType<typeof loadConfig>["slackWorkspaceInvite"];
}): Promise<{
  loginResult?: Awaited<ReturnType<SlackBrowserLoginConnector["login"]>>;
  revokeResult: Awaited<ReturnType<SlackBrowserWorkspaceRevokeConnector["revokeUserFromWorkspace"]>>;
}> {
  try {
    return {
      revokeResult: await input.connector.revokeUserFromWorkspace({ email: input.email })
    };
  } catch (error) {
    if (!(error instanceof SlackConnectorError) || error.code !== SLACK_CONNECTOR_ERROR_CODE.browserNotLoggedIn) {
      throw error;
    }

    const loginConnector = new SlackBrowserLoginConnector({
      workspaceUrl: input.config.browserWorkspaceUrl!,
      profileDir: input.config.browserProfileDir!,
      loginMode: input.config.browserLoginMode,
      loginEmail: input.config.browserLoginEmail,
      loginPassword: input.config.browserLoginPassword,
      headless: input.config.browserHeadless,
      timeoutMs: input.config.browserInviteTimeoutMs
    });

    const loginResult = await loginConnector.login();
    const revokeResult = await input.connector.revokeUserFromWorkspace({ email: input.email });

    return {
      loginResult,
      revokeResult: {
        ...revokeResult,
        loginRecovered: loginResult.loginRecovered,
        retryAfterLogin: true
      }
    };
  }
}

function normalizeEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeSafeError(error: unknown): SafeSmokeError {
  if (error instanceof SlackConnectorError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: "unknown_error",
      message: error.message
    };
  }

  return {
    code: "unknown_error",
    message: "Slack workspace revoke smoke test failed."
  };
}

function printResult(result: SmokeResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
