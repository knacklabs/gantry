import fs from 'fs';
export function resolveChromeExecutablePath(platform = process.platform) {
    if (platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ];
    return (candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]);
}
