# Model Providers clarity cleanup

## Goal

Make the Model Providers page answer one question per row: whether Gantry can
use the provider now, why an absent credential matters, and the next available
action. Keep the existing browser facade, credential behavior, and initials
fallback unchanged.

## Scope

- Remove duplicate navigation: the header `Add provider` control and its
  picker. Administrators act directly from the provider row.
- Keep search and the status select, but remove the decorative Enter icon
  because filtering occurs while typing.
- Reduce every row to initials, provider name, an optional compact requirement
  reason, one precise status pill, and its role-appropriate action.
- Replace the ambiguous `Attention` presentation with:
  - `Required` for a missing provider that current runtime selection needs;
  - `Not configured` for an optional provider with no active credential;
  - `Configured` for an active stored credential; and
  - `Disabled` for an inactive credential.
- Give each status pill an accessible Radix tooltip. It must appear on hover
  and keyboard focus, explain the status in one sentence, and never claim that
  a configured credential has completed upstream verification.
- Remove the per-row workload dump and update date. Show full runtime reasons
  only in the management dialog when they are relevant.
- Use explicit admin actions: `Add credential`, `Manage credential`, `Verify`,
  `Update credential`, and `Disable provider`. A Viewer sees no redundant
  dialog action.
- Preserve write-only secret handling and disable confirmation. Add clear
  disabled-state copy, safe next-step error copy, and polite live feedback for
  verify results.

## Boundaries

No change to the model-provider registry, browser API response, credential
storage, verification semantics, roles, authorization, settings, or provider
artwork. This is a web-only clarity pass.

## Verification

- Update focused web tests for status text, tooltip content, and role actions.
- Run web typecheck and focused tests.
- Manually validate the local Providers screen as Administrator and Viewer,
  including hover/focus tooltip behavior and the disabled confirmation.
