import { Monitor, Moon, Sun } from 'lucide-react';

import { PageHeader } from '../../ui/compositions/page-header';
import { SegmentedControl } from '../../ui/primitives/segmented-control';
import { Switch } from '../../ui/primitives/switch';
import { usePreferences } from './preferences-provider';

export function PreferencesRoute() {
  const { preferences, setReduceMotion, setTheme } = usePreferences();

  return (
    <section
      className="mx-auto max-w-[840px]"
      aria-labelledby="preferences-title"
    >
      <PageHeader
        eyebrow="Local preferences"
        title="Profile"
        id="preferences-title"
      />
      <div className="mt-7 border-t border-border">
        <section
          aria-labelledby="appearance-title"
          className="flex items-center justify-between gap-6 border-b border-border py-6 max-sm:flex-col max-sm:items-start max-sm:gap-4"
        >
          <div>
            <h2 className="m-0 text-sm font-semibold" id="appearance-title">
              Appearance
            </h2>
            <p className="mt-1.5 mb-0 text-[13px] leading-5 text-text-secondary">
              Choose how Gantry looks in this browser.
            </p>
          </div>
          <SegmentedControl
            aria-label="Theme preference"
            onValueChange={setTheme}
            options={[
              { value: 'system', label: 'System', icon: Monitor },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon },
            ]}
            value={preferences.theme}
          />
        </section>
        <section
          aria-labelledby="motion-title"
          className="flex items-center justify-between gap-6 border-b border-border py-6 max-sm:flex-col max-sm:items-start max-sm:gap-4"
        >
          <div>
            <h2 className="m-0 text-sm font-semibold" id="motion-title">
              Motion
            </h2>
            <p className="mt-1.5 mb-0 text-[13px] leading-5 text-text-secondary">
              Turn off nonessential interface motion.
            </p>
          </div>
          <Switch
            checked={preferences.reduceMotion}
            label="Reduce motion"
            onCheckedChange={setReduceMotion}
          />
        </section>
      </div>
    </section>
  );
}
