import type { OnboardingDraft } from './onboarding-state';

const KEY = 'gantry:onboarding-employee-draft';

export function readOnboardingEmployeeDraft(
  storage: Pick<Storage, 'getItem'> = window.sessionStorage,
): Pick<
  OnboardingDraft,
  'name' | 'title' | 'responsibilities' | 'effort'
> | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const draft = value as Record<string, unknown>;
    if (
      typeof draft.name !== 'string' ||
      typeof draft.title !== 'string' ||
      typeof draft.responsibilities !== 'string'
    )
      return null;
    return {
      name: draft.name,
      title: draft.title,
      responsibilities: draft.responsibilities,
      effort: ['low', 'medium', 'high', 'xhigh'].includes(String(draft.effort))
        ? (draft.effort as OnboardingDraft['effort'])
        : undefined,
    };
  } catch {
    return null;
  }
}

export function saveOnboardingEmployeeDraft(
  draft: OnboardingDraft,
  storage: Pick<Storage, 'setItem'> = window.sessionStorage,
): void {
  try {
    storage.setItem(
      KEY,
      JSON.stringify({
        name: draft.name,
        title: draft.title,
        responsibilities: draft.responsibilities,
        effort: draft.effort,
      }),
    );
  } catch {
    // Onboarding remains usable when browser storage is disabled.
  }
}

export function clearOnboardingEmployeeDraft(
  storage: Pick<Storage, 'removeItem'> = window.sessionStorage,
): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* Storage may be disabled. */
  }
}
