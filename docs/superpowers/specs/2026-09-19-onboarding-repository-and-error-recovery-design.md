# Onboarding Repository and Error Recovery Design

## Scope

Split the oversized Postgres onboarding lifecycle repository into focused persistence owners and add two cohesive critical-error surfaces:

- a full-screen fallback when the React root, providers, or application shell fail;
- an in-shell fallback when an individual route fails.

No onboarding behavior, database schema, error telemetry, or recovery workflow changes are included.

## Persistence boundaries

Retain `onboarding-lifecycle-repository.postgres.ts` as the small public composition façade and move its persistence behavior into four repositories under `repositories/onboarding/`:

```text
apps/core/src/adapters/storage/postgres/repositories/onboarding/
├── onboarding-candidate-repository.postgres.ts
├── onboarding-deployment-repository.postgres.ts
├── onboarding-employee-activation-repository.postgres.ts
└── onboarding-verification-repository.postgres.ts
```

### Deployment repository

Owns the onboarding deployment row and its safe status projection, idempotent operation records, runtime projection receipts, and Slack work-assignment transition. It also exposes the transaction-aware deployment upsert used by the other repositories.

### Candidate repository

Owns encrypted, expiring model-credential and Slack-workspace candidates. It preserves the current credential AAD, expiry rules, transition assertions, model-selection binding, and Slack activation transaction.

### Employee activation repository

Owns the atomic transaction that activates the verified model credential and creates the Agent, service Person, custom role, LLM profile, configuration version, settings revision, audit event, and deployment transition. This remains a concrete repository because the transaction is one business operation, not a reusable helper.

### Verification repository

Owns verification challenge creation, expiry and supersession, trusted inbound matching, single-use consumption, Agent run correlation, final-answer delivery receipt checks, and the final Ready transition.

### Composition and callers

`PostgresOnboardingLifecycleRepository` remains at its current import path and preserves its current public methods. It constructs the four repositories and explicitly delegates lifecycle operations to them. This keeps browser routes, runtime ingress, boot wiring, and existing mocks stable while moving every query, encryption operation, and transaction into its focused owner.

The façade contains no duplicated queries or business logic and stays below the repository line budget. No compatibility shim, re-export-only module, generic utility folder, or new interface with one implementation is introduced.

Existing transaction boundaries, app/user scoping, error behavior, encryption, and public API contracts remain unchanged.

## Error recovery

### Root failure: full-screen recovery

`CriticalErrorBoundary` wraps `App` at the React root. Its fallback does not depend on the router, application shell, query client, or feature providers.

The full-screen page follows selected mockup A:

- Gantry mark and wordmark in the upper-left;
- the existing canvas and soft green upper-left ambient bleed;
- a centered surface panel with the danger-soft icon tile and mono `SYSTEM INTERRUPTION` eyebrow;
- heading `Gantry stopped unexpectedly`;
- recovery copy that directs the user to reload first and return to Overview if the failure continues;
- primary `Reload console` button using `window.location.reload()`;
- secondary hard anchor `Back to Overview` using the configured web base path.

The hard anchor is intentional because router state cannot be trusted at this boundary.

### Route failure: in-shell recovery

TanStack Router uses `RouteErrorPage` as its default route error component. It follows selected mockup B and renders inside the healthy application shell:

- the sidebar, theme control, full-screen control, background bleed, and top status rail remain visible;
- the route content area shows a compact error panel;
- eyebrow `VIEW UNAVAILABLE`;
- heading `This view could not load`;
- primary `Reload view` button;
- secondary `Back to Overview` navigation.

The route page does not promote a view-level failure into a full application crash.

### Shared presentation

Both variants reuse one small recovery-panel composition and the existing `Button`, `buttonVariants`, `GantryMark`, semantic tokens, typography, radii, shadows, focus treatment, theme provider, and reduced-motion rules. They do not render raw error messages, stack traces, credentials, request details, or speculative incident identifiers.

## Accessibility

- Each surface has one visible `h1` and an `alert` region labelled by that heading.
- The heading receives programmatic focus when the fallback mounts.
- Actions are native buttons or anchors with visible focus styles.
- Decorative marks, glow, and warning glyphs are hidden from assistive technology.
- Root recovery remains usable below the console's normal 768px breakpoint.
- No required information depends on animation.

## Verification

### Persistence

- Existing route and state-machine tests continue to pass after dependency rewiring.
- Add focused repository tests for encrypted candidate transitions and successful verification-to-Ready correlation.
- Run typecheck, lint, migration validation, production builds, and the architecture checker.
- Confirm every caller still uses the stable lifecycle façade and no SQL remains in it.

### Web

- Test that `main.tsx` installs the root boundary.
- Test that the router installs the route error component.
- Test both headlines, recovery actions, semantic alert markup, and the absence of raw error output.
- Manually force a route render failure and a provider/root failure.
- Audit desktop and narrow root recovery plus expanded/collapsed shell route recovery in light, dark, keyboard, and reduced-motion modes.

## Deliberate exclusions

- No global `error` or `unhandledrejection` listeners. React boundaries do not catch detached async or event-handler failures; add targeted handling only when a concrete failure requires it.
- No incident reference until Gantry has a real telemetry correlation ID.
- No per-route bespoke error pages.
- No schema or API changes.
