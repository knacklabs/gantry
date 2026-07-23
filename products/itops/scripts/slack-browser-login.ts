import { loadEnvFiles } from "@itops/config";
import { SlackBrowserLoginConnector, type SlackBrowserLoginMode } from "@itops/connectors";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Slack browser login setup failed.";
  console.error(message);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadEnvFiles();

  const workspaceUrl = requireEnv("SLACK_BROWSER_WORKSPACE_URL");
  const profileDir = requireEnv("SLACK_BROWSER_PROFILE_DIR");
  const loginMode = parseLoginMode(process.env.SLACK_BROWSER_LOGIN_MODE);
  const loginEmail = loginMode === "google_sso" ? requireEnv("SLACK_BROWSER_LOGIN_EMAIL") : undefined;
  const loginPassword = loginMode === "google_sso" ? requireEnv("SLACK_BROWSER_LOGIN_PASSWORD") : undefined;

  if (loginMode === "manual") {
    console.error("Log in to Slack manually. Complete SSO/MFA if needed. Close the browser when done.");
  } else {
    console.error("Automating Slack Google SSO login. No credentials or browser session values will be printed.");
  }

  const connector = new SlackBrowserLoginConnector({
    workspaceUrl,
    profileDir,
    loginMode,
    loginEmail,
    loginPassword,
    headless: false
  });

  const result = await connector.login();

  console.error(result.message);
  console.error("Slack browser profile saved.");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parseLoginMode(value: string | undefined): SlackBrowserLoginMode {
  if (!value || value === "manual" || value === "google_sso") {
    return value ?? "manual";
  }

  throw new Error("SLACK_BROWSER_LOGIN_MODE must be manual or google_sso.");
}
