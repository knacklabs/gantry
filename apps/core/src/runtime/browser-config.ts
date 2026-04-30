import { CHROME_PATH as configuredChromePath } from '../config/index.js';

export const DEFAULT_CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--remote-debugging-address=127.0.0.1',
] as const;

export interface ChromeLaunchArgsInput {
  userDataDir: string;
  port: number;
  headless?: boolean;
  platform?: NodeJS.Platform;
  uid?: number;
}

function shouldDisableSandbox(input: ChromeLaunchArgsInput): boolean {
  return input.platform === 'linux' && input.uid === 0;
}

export function buildChromeLaunchArgs(input: ChromeLaunchArgsInput): string[] {
  const platform = input.platform ?? process.platform;
  const uid = input.uid ?? process.getuid?.();
  const sandboxArgs = shouldDisableSandbox({ ...input, platform, uid })
    ? ['--no-sandbox']
    : [];

  return [
    ...DEFAULT_CHROME_ARGS,
    ...sandboxArgs,
    ...(input.headless === false ? [] : ['--headless=new']),
    `--user-data-dir=${input.userDataDir}`,
    `--remote-debugging-port=${input.port}`,
  ];
}

export const DEFAULT_BROWSER_KEEPALIVE_MS = 5 * 60 * 1000;

export const CHROME_PATH = configuredChromePath;
