export type ThemePreference = 'system' | 'light' | 'dark';

export type Preferences = {
  theme: ThemePreference;
  reduceMotion: boolean;
};

const STORAGE_KEY = 'gantry.ui.preferences.v1';
const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  reduceMotion: false,
};

export function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const value: unknown = JSON.parse(raw);
    if (!isPreferences(value)) return DEFAULT_PREFERENCES;
    return value;
  } catch (error) {
    if (error instanceof SyntaxError || isStorageAccessError(error)) {
      return DEFAULT_PREFERENCES;
    }
    throw error;
  }
}

export function writePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    if (isStorageAccessError(error)) return;
    throw error;
  }
}

function isStorageAccessError(error: unknown): error is DOMException {
  return error instanceof DOMException;
}

function isPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.theme === 'system' ||
      candidate.theme === 'light' ||
      candidate.theme === 'dark') &&
    typeof candidate.reduceMotion === 'boolean'
  );
}
