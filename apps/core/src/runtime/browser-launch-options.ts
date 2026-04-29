import { DEFAULT_BROWSER_KEEPALIVE_MS } from './browser-config.js';

function isCiLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return [
    'CI',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
  ].some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0 && value !== 'false';
  });
}

export function resolveBrowserHeadless(explicit: boolean | undefined): boolean {
  return explicit ?? isCiLikeEnv();
}

export function resolveBrowserKeepAliveMs(value: number | undefined): number {
  return Math.max(10_000, value || DEFAULT_BROWSER_KEEPALIVE_MS);
}
