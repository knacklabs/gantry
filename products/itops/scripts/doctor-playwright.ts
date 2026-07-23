import { access, constants, mkdir, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadEnvFiles } from "@itops/config";
import { chromium } from "playwright";

const CHECK_FILE_NAME = ".itops-playwright-doctor";

type CheckStatus = "pass" | "fail" | "skip";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Playwright doctor failed.";
  console.error(message);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadEnvFiles();

  const mode = process.env.SLACK_WORKSPACE_INVITE_MODE?.trim() || "manual";

  if (mode !== "browser") {
    report("skip", "Slack browser invite mode is not enabled.");
    report("skip", "Set SLACK_WORKSPACE_INVITE_MODE=browser to require Playwright browser checks.");
    return;
  }

  const workspaceUrl = requireEnv("SLACK_BROWSER_WORKSPACE_URL");
  const profileDir = requireEnv("SLACK_BROWSER_PROFILE_DIR");
  const headless = parseBoolean(process.env.SLACK_BROWSER_HEADLESS, true);

  validateWorkspaceUrl(workspaceUrl);
  await assertBrowserInstalled();
  await assertProfileDirWritable(profileDir);
  await assertHeadlessLaunch({ workspaceUrl, profileDir, headless });

  report("pass", "Playwright is ready for Slack browser invite mode.");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required when SLACK_WORKSPACE_INVITE_MODE=browser.`);
  }

  report("pass", `${name} is configured.`);
  return value;
}

function validateWorkspaceUrl(value: string): void {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("SLACK_BROWSER_WORKSPACE_URL must use https.");
  }

  report("pass", "SLACK_BROWSER_WORKSPACE_URL is a valid https URL.");
}

async function assertBrowserInstalled(): Promise<void> {
  const executablePath = chromium.executablePath();

  try {
    await access(executablePath, constants.X_OK);
  } catch {
    throw new Error(
      `Playwright Chromium executable was not found or is not executable at ${executablePath}. Run: pnpm exec playwright install chromium`
    );
  }

  report("pass", "Playwright Chromium executable is installed.");
}

async function assertProfileDirWritable(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const profileStat = await stat(profileDir);

  if (!profileStat.isDirectory()) {
    throw new Error(`SLACK_BROWSER_PROFILE_DIR is not a directory: ${profileDir}`);
  }

  const checkFilePath = join(profileDir, CHECK_FILE_NAME);
  await writeFile(checkFilePath, "ok\n", { mode: 0o600 });
  await unlink(checkFilePath);

  report("pass", "SLACK_BROWSER_PROFILE_DIR exists and is writable.");
}

async function assertHeadlessLaunch(input: {
  workspaceUrl: string;
  profileDir: string;
  headless: boolean;
}): Promise<void> {
  const smokeProfileDir = join(dirname(input.profileDir), `${CHECK_FILE_NAME}-${process.pid}`);
  const context = await chromium.launchPersistentContext(smokeProfileDir, {
    headless: input.headless,
    viewport: null,
    args: [
      "--ozone-platform=x11",
      "--use-gl=swiftshader",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-position=100,100",
      "--window-size=1280,900"
    ]
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(input.workspaceUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    report("pass", `Chromium launched with headless=${String(input.headless)} and reached Slack.`);
  } catch (error) {
    throw new Error(
      `Playwright Chromium could not launch or reach Slack. Install browser dependencies with: sudo pnpm exec playwright install-deps chromium. ${error instanceof Error ? error.message : ""}`.trim()
    );
  } finally {
    await context.close();
  }
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  throw new Error("SLACK_BROWSER_HEADLESS must be true or false.");
}

function report(status: CheckStatus, message: string): void {
  console.info(`[${status}] ${message}`);
}
