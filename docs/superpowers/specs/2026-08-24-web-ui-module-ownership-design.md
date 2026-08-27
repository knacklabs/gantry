# Web UI module ownership design

## Goal

Keep the Model Providers work reviewable by separating page composition from
state-specific views, and make web assets consistently discoverable.

## Scope

- Split `authentication-access-route.tsx` into route composition, sign-in and
  revalidation views, and shared form helpers.
- Split `auth-pages.tsx` into one module per auth page/state.
- Split `providers-route.tsx` into route orchestration, provider list,
  credential dialog/form, and status presentation modules.
- Add `apps/web/AGENTS.md` with the asset rule: source-owned SVGs and other
  assets live in `src/assets/<feature>/`, exported by that feature's `index.ts`.
  Components import those assets; do not inline SVG markup or data URIs.
- Rebuild the feature history into coherent commits: secured backend façade,
  provider UI/assets, auth-page organization, then documentation/rules.

## Boundaries

Route modules should stay below 300 lines when practical. Larger leaf
components are split only when a real responsibility boundary exists. Existing
large workflow and agent components are not part of this change unless their
inspection finds a clear, local boundary.

## Verification

Run the focused auth/provider tests, web and root typechecks, deterministic
repository verification, and branch autoreview after the final history is
rebuilt.
