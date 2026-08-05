import { Monitor, Moon, Sun } from 'lucide-react';

import { PageHeader } from '../../ui/compositions/page-header';
import { Field, FieldLabel } from '../../ui/primitives/field';
import { Switch } from '../../ui/primitives/switch';
import { ToggleGroup, ToggleGroupItem } from '../../ui/primitives/toggle-group';
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
          <ToggleGroup
            aria-label="Theme preference"
            onValueChange={(theme) =>
              theme && setTheme(theme as typeof preferences.theme)
            }
            type="single"
            value={preferences.theme}
          >
            <ToggleGroupItem value="system">
              <Monitor aria-hidden="true" />
              System
            </ToggleGroupItem>
            <ToggleGroupItem value="light">
              <Sun aria-hidden="true" />
              Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark">
              <Moon aria-hidden="true" />
              Dark
            </ToggleGroupItem>
          </ToggleGroup>
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
          <Field orientation="horizontal">
            <FieldLabel htmlFor="reduce-motion">Reduce motion</FieldLabel>
            <Switch
              checked={preferences.reduceMotion}
              id="reduce-motion"
              onCheckedChange={setReduceMotion}
            />
          </Field>
        </section>
      </div>
    </section>
  );
}
