import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { CircleOff, Monitor, Moon, Sun } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Theme = 'system' | 'light' | 'dark';
type Preferences = { theme: Theme; reduceMotion: boolean };
type PreferencesContextValue = Preferences & {
  setTheme: (theme: Theme) => void;
  setReduceMotion: (value: boolean) => void;
};

const STORAGE_KEY = 'gantry.ui.preferences.v1';
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});
const preferencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'preferences',
  component: PreferencesPage,
});
const router = createRouter({
  basepath: '/ui',
  routeTree: rootRoute.addChildren([homeRoute, preferencesRoute]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <PreferencesProvider>
      <RouterProvider router={router} />
    </PreferencesProvider>
  );
}

function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? '{}',
      ) as Partial<Preferences>;
      return {
        theme:
          value.theme === 'light' ||
          value.theme === 'dark' ||
          value.theme === 'system'
            ? value.theme
            : 'system',
        reduceMotion: value.reduceMotion === true,
      };
    } catch {
      return { theme: 'system', reduceMotion: false };
    }
  });
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effectiveTheme =
    preferences.theme === 'system'
      ? systemDark
        ? 'dark'
        : 'light'
      : preferences.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.motion = preferences.reduceMotion
      ? 'reduced'
      : 'standard';
    document.documentElement.style.colorScheme = effectiveTheme;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* Browser storage is optional. */
    }
  }, [effectiveTheme, preferences]);

  const value = useMemo(
    () => ({
      ...preferences,
      setTheme: (theme: Theme) =>
        setPreferences((current) => ({ ...current, theme })),
      setReduceMotion: (reduceMotion: boolean) =>
        setPreferences((current) => ({ ...current, reduceMotion })),
    }),
    [preferences],
  );
  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value)
    throw new Error('Preferences must be available inside the Gantry shell.');
  return value;
}

function Shell() {
  const { theme, setTheme } = usePreferences();
  const ThemeIcon = theme === 'dark' ? Sun : theme === 'light' ? Moon : Monitor;
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand" to="/">
          <span>G</span>Gantry
        </Link>
        <nav>
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ className: 'active' }}
            to="/"
          >
            Home
          </Link>
          <Link activeProps={{ className: 'active' }} to="/preferences">
            Preferences
          </Link>
        </nav>
      </aside>
      <div className="content">
        <header>
          <span className="connection">
            <CircleOff aria-hidden="true" size={15} />
            Not connected
          </span>
          <button
            aria-label="Cycle theme preference"
            className="icon-button"
            onClick={() =>
              setTheme(
                theme === 'system'
                  ? 'light'
                  : theme === 'light'
                    ? 'dark'
                    : 'system',
              )
            }
            type="button"
          >
            <ThemeIcon aria-hidden="true" size={17} />
          </button>
        </header>
        <main id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Home() {
  return (
    <section className="page" aria-labelledby="page-title">
      <div>
        <p className="eyebrow">Gantry</p>
        <h1 id="page-title">Operator shell</h1>
      </div>
      <div className="state-card">
        <CircleOff aria-hidden="true" size={24} />
        <div>
          <h2>Not connected</h2>
          <p>Runtime access is not configured for this browser.</p>
        </div>
      </div>
    </section>
  );
}

function PreferencesPage() {
  const { reduceMotion, setReduceMotion, setTheme, theme } = usePreferences();
  return (
    <section className="page narrow" aria-labelledby="preferences-title">
      <div>
        <p className="eyebrow">Local preferences</p>
        <h1 id="preferences-title">Preferences</h1>
      </div>
      <section className="preference" aria-labelledby="theme-title">
        <div>
          <h2 id="theme-title">Appearance</h2>
          <p>Choose how Gantry looks in this browser.</p>
        </div>
        <fieldset aria-label="Theme preference">
          <button
            aria-pressed={theme === 'system'}
            onClick={() => setTheme('system')}
            type="button"
          >
            System
          </button>
          <button
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
            type="button"
          >
            Light
          </button>
          <button
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
            type="button"
          >
            Dark
          </button>
        </fieldset>
      </section>
      <section className="preference" aria-labelledby="motion-title">
        <div>
          <h2 id="motion-title">Motion</h2>
          <p>Turn off nonessential interface motion.</p>
        </div>
        <label>
          <span>Reduce motion</span>
          <input
            checked={reduceMotion}
            onChange={(event) => setReduceMotion(event.target.checked)}
            type="checkbox"
          />
        </label>
      </section>
    </section>
  );
}

function NotFound() {
  return (
    <section className="page narrow">
      <div className="state-card">
        <CircleOff aria-hidden="true" size={24} />
        <div>
          <h1>View not found</h1>
          <p>The requested view is not available.</p>
          <Link className="button" to="/">
            Back home
          </Link>
        </div>
      </div>
    </section>
  );
}
