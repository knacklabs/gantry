export type BrowserAuthenticationMode = 'local' | 'hosted';

let authenticationMode: BrowserAuthenticationMode | undefined;

export function isBrowserAuthenticationMode(
  value: unknown,
): value is BrowserAuthenticationMode {
  return value === 'local' || value === 'hosted';
}

export function rememberBrowserAuthenticationMode(
  mode: BrowserAuthenticationMode,
) {
  authenticationMode = mode;
}

export function browserCsrfHeader(): Record<string, string> {
  const token = document.cookie
    .split('; ')
    .find(
      (entry) =>
        entry.startsWith('gantry_csrf=') ||
        entry.startsWith('__Host-gantry-csrf='),
    )
    ?.split('=')
    .slice(1)
    .join('=');
  return token ? { 'x-csrf-token': decodeURIComponent(token) } : {};
}

export async function browserFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && authenticationMode === 'local') {
    window.location.assign('/ui/auth/local?reason=session-expired');
  }
  return response;
}

export async function requestLocalAuthorizationUrl(): Promise<string> {
  const response = await browserFetch('/ui/api/auth/local/authorize', {
    method: 'POST',
    credentials: 'same-origin',
    headers: browserCsrfHeader(),
  });
  const body = (await response.json().catch(() => null)) as {
    authorizationUrl?: string;
  } | null;
  if (!response.ok || !body?.authorizationUrl) {
    throw new Error('Unable to create an authorization link.');
  }
  return body.authorizationUrl;
}
