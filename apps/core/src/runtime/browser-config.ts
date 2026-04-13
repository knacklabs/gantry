export const DEFAULT_CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--remote-debugging-address=127.0.0.1',
] as const;

export const DEFAULT_CHROME_IGNORE_ARGS = ['--enable-automation'] as const;

export const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 800,
} as const;

export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_BROWSER_KEEPALIVE_MS = 5 * 60 * 1000;

export const CHROME_PATH = process.env.CHROME_PATH?.trim() || undefined;
