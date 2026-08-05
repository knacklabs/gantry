import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  readPreferences,
  type Preferences,
  type ThemePreference,
  writePreferences,
} from './preferences';

type EffectiveTheme = Exclude<ThemePreference, 'system'>;

type PreferencesContextValue = {
  preferences: Preferences;
  effectiveTheme: EffectiveTheme;
  setReduceMotion: (reduceMotion: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [systemTheme, setSystemTheme] =
    useState<EffectiveTheme>(readSystemTheme);
  const effectiveTheme =
    preferences.theme === 'system' ? systemTheme : preferences.theme;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = () =>
      setSystemTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', updateSystemTheme);
    return () => media.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    const systemReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.motion =
      preferences.reduceMotion || systemReducedMotion ? 'reduced' : 'standard';
    document.documentElement.style.colorScheme = effectiveTheme;
  }, [effectiveTheme, preferences.reduceMotion]);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      effectiveTheme,
      setReduceMotion: (reduceMotion) =>
        setPreferences((current) => {
          const next = { ...current, reduceMotion };
          writePreferences(next);
          return next;
        }),
      setTheme: (theme) =>
        setPreferences((current) => {
          const next = { ...current, theme };
          writePreferences(next);
          return next;
        }),
    }),
    [effectiveTheme, preferences],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) {
    throw new Error('usePreferences must be used within PreferencesProvider.');
  }
  return value;
}

function readSystemTheme(): EffectiveTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
