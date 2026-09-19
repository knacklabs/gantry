import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';

export type LifecycleCheck = {
  id: string;
  label: string;
  status: 'pass' | 'fail';
  detail?: string;
};

export async function onboardingMutation<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const response = await browserFetch(`/ui/api/onboarding${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      ...browserCsrfHeader(),
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | T
    | null;
  if (!response.ok) {
    throw Object.assign(
      new Error(
        isErrorPayload(payload) && payload.error?.message
          ? payload.error.message
          : 'Onboarding request failed.',
      ),
      { payload },
    );
  }
  return payload as T;
}

export async function onboardingGet<T>(path: string): Promise<T> {
  const response = await browserFetch(`/ui/api/onboarding${path}`, {
    credentials: 'same-origin',
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | T
    | null;
  if (!response.ok) {
    throw new Error(
      isErrorPayload(payload) && payload.error?.message
        ? payload.error.message
        : 'Onboarding request failed.',
    );
  }
  return payload as T;
}

function isErrorPayload(
  value: unknown,
): value is { error?: { message?: string } } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
