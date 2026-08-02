export const DEFAULT_CHROME_ARGS = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=OmniboxPopup',
    '--window-size=1280,900',
    '--remote-debugging-address=127.0.0.1',
];
function shouldDisableSandbox(input) {
    return input.platform === 'linux' && input.uid === 0;
}
export function buildChromeLaunchArgs(input) {
    const platform = input.platform ?? process.platform;
    const uid = input.uid ?? process.getuid?.();
    const sandboxArgs = shouldDisableSandbox({ ...input, platform, uid })
        ? ['--no-sandbox']
        : [];
    return [
        ...DEFAULT_CHROME_ARGS,
        ...sandboxArgs,
        `--user-data-dir=${input.userDataDir}`,
        `--remote-debugging-port=${input.port}`,
    ];
}
export const DEFAULT_BROWSER_KEEPALIVE_MS = 5 * 60 * 1000;
