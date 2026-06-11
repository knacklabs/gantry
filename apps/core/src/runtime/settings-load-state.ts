/**
 * Process-level gate for whether runtime desired state has been loaded.
 *
 * Workstation always loads from `settings.yaml`, so this stays `true`. Fleet
 * boot sets it `false` until a `settings_revisions` row has been fetched and
 * applied; `/readyz` reads this through `routes/system.ts` so a first fleet boot
 * with no seeded revision reports not-ready (ADR-3) without touching the pure
 * `system-health.ts` evaluator.
 */
let settingsLoaded = true;

export function markSettingsLoaded(): void {
  settingsLoaded = true;
}

export function markSettingsNotLoaded(): void {
  settingsLoaded = false;
}

export function areSettingsLoaded(): boolean {
  return settingsLoaded;
}
