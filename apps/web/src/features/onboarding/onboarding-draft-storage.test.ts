import { describe, expect, it } from 'vitest';

import {
  clearOnboardingEmployeeDraft,
  readOnboardingEmployeeDraft,
  saveOnboardingEmployeeDraft,
} from './onboarding-draft-storage';
import { initialOnboardingDraft } from './onboarding-state';

describe('onboarding employee draft', () => {
  it('restores the entered name after a page reload instead of Atlas', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
      removeItem: (key: string) => {
        items.delete(key);
      },
    };
    saveOnboardingEmployeeDraft(
      {
        ...initialOnboardingDraft,
        name: 'MIA',
        title: 'Claims assistant',
        effort: 'high',
      },
      storage,
    );
    expect(readOnboardingEmployeeDraft(storage)).toMatchObject({
      name: 'MIA',
      title: 'Claims assistant',
      effort: 'high',
    });
    clearOnboardingEmployeeDraft(storage);
    expect(readOnboardingEmployeeDraft(storage)).toBeNull();
  });
});
