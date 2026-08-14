import fs from 'fs';

export function resolveChromeExecutablePath(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (executable) return executable;
  throw new Error(
    'Google Chrome is required for the managed browser, but no Google Chrome executable was found.',
  );
}
