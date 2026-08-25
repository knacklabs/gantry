# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task WEB-BRAND-1-1

### Plan contracts

- **auth-mark**
  - Source: plans/active/WEB-BRAND-1-gantry-web-console-logo-assets.md#Acceptance Criteria
  - Statement: Auth pages use a 28px bronze #C0985F canonical mark beside the existing uppercase GANTRY wordmark, with no bordered G badge.
- **sidebar-mark**
  - Source: plans/active/WEB-BRAND-1-gantry-web-console-logo-assets.md#Acceptance Criteria
  - Statement: The sidebar uses a 24px --ink canonical mark beside the existing Gantry label and remains legible in both themes.
- **browser-assets**
  - Source: plans/active/WEB-BRAND-1-gantry-web-console-logo-assets.md#Acceptance Criteria
  - Statement: Browser icons use a dark #1B1A18 tile with an off-white #F7F6F4 mark: an SVG favicon and one 180 by 180 touch icon served under /ui/.
- **preserve-ui**
  - Source: plans/active/WEB-BRAND-1-gantry-web-console-logo-assets.md#Acceptance Criteria
  - Statement: Existing auth copy, routes, navigation labels, page title, layout, and Google sign-in treatment do not change.
- **no-extra-surface**
  - Source: plans/active/WEB-BRAND-1-gantry-web-console-logo-assets.md#Acceptance Criteria
  - Statement: No PWA manifest, unused icon sizes, external image request, duplicate wordmark image, new dependency, API, schema, persistence, configuration, or runtime behavior is added.

### Reviewer focus

Verify the mark geometry and colors match the approved concept, auth/sidebar text and Google sign-in behavior are unchanged, assets resolve below the /ui/ Vite base without external requests, and no runtime/API/schema/config/PWA surface or new dependency is introduced.
