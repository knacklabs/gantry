# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task WEB-AUTH-1-1

### Plan contracts

- **AUTH-FOUNDATION-0**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Postgres migrations and repositories cover local authorization codes, OIDC transactions, browser sessions, console access grants, and invitations.
- **AUTH-FOUNDATION-1**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: All reusable tokens and references are stored as hashes only, one-use records are consumed atomically, and the final active Administrator invariant is transactionally enforced.
- **AUTH-FOUNDATION-2**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Authentication settings add local or hosted mode, canonical origin, generic OIDC candidate and active configuration, and client-secret references without changing runtime.deployment_mode.
- **AUTH-FOUNDATION-3**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: OIDC issuer plus subject aliases and verified email aliases reuse the existing Person and user_aliases model; email never selects or silently links a Person.

### Reviewer focus

Hash-only storage, atomic one-use consumption, final-active-Administrator locking, and client-secret references that never project raw values.

## Task WEB-AUTH-1-2

### Plan contracts

- **AUTH-BOUNDARY-0**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Browser and Bearer credentials are mutually exclusive; browser session and CSRF cookies use the required local and hosted attributes, and authentication responses are no-store capable.
- **AUTH-BOUNDARY-1**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Browser mutations can require exact canonical Origin plus a synchronizer CSRF token, while local browser authorization recognizes only loopback hosts.
- **AUTH-BOUNDARY-2**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Every Control scope is classified as Administrator, Viewer-safe read, or browser-ineligible, with Viewer access read-only by policy.

### Reviewer focus

Cookie flags, exact-origin and CSRF policy, loopback-only recognition, Bearer/session mutual exclusion, and exhaustive Viewer scope classification.

## Task WEB-AUTH-1-3

### Plan contracts

- **AUTH-HOSTED-0**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Generic OIDC validates discovery issuer, state, nonce, PKCE, signature, audience, expiry, replay, and allowlisted outbound transport without exposing provider errors.
- **AUTH-HOSTED-1**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Public local and hosted auth routes consume only opaque, hashed browser credentials; local authorization remains loopback-only and one-use, while browser and Bearer routes reject each other.
- **AUTH-HOSTED-2**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Hosted identity is keyed by issuer plus subject, verified email is separate, access grants and invitations enforce role, expiry, email matching, reauthentication, rotation, and revocation semantics.
- **AUTH-HOSTED-3**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Only the full Control profile mounts UI and browser-auth routes; authentication responses are no-store and operational worker profiles do not expose the browser surface.

### Reviewer focus

OIDC signature and claim validation, pinned outbound transport, opaque session boundaries, loopback enforcement, safe audit event types, token/error hygiene, and full-profile-only route mounting.

## Task WEB-AUTH-1-4

### Plan contracts

- **AUTH-OPS-0**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: gantry ui and gantry ui authorize create local authorization links, and gantry auth access approve <reference> --role administrator|viewer writes the grant and audit event transactionally after confirmation.
- **AUTH-OPS-1**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: First-admin and lost-admin access references expire after 15 minutes and are stored as hashes on awaiting grants.
- **AUTH-OPS-2**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: OIDC candidate testing never changes active runtime behavior, failed tests preserve active configuration, and activation promotes the candidate through settings revisions.
- **AUTH-OPS-3**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Audit events cover login classification, logout, revocation, invitations, access and role changes, reauthentication, configuration activation, and CLI recovery without tokens, raw claims, secrets, PKCE verifiers, or upstream errors.
- **AUTH-OPS-4**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Docs cover local startup, hosted proxy and cache requirements, setup, first-admin approval, lost-admin recovery, and broken-OIDC recovery.

### Reviewer focus

Trusted first and lost administrator approval, one-time local authorization output, transactionality, safe operator messaging, no secret/raw-claim output, active-versus-candidate OIDC settings behavior, and CLI architecture boundary declarations. Confirm the CLI recovery audit insert uses the same transaction as grant activation and has only safe fields.

## Task WEB-AUTH-1-5

### Plan contracts

- **AUTH-UI-0**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Public local authorization, hosted sign-in, invitation, callback failure, no-access, disabled-access, retry, setup, and reauthentication screens use the exact approved copy.
- **AUTH-UI-1**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: The AppShell is protected by session-aware route loading, while public auth routes live outside the shell.
- **AUTH-UI-2**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Settings to Authentication and Access shows the approved adaptive local and hosted tabs, Administrator and Viewer roles only, invitations, access administration, session management, OIDC setup, receipts, and final-admin error behavior.
- **AUTH-UI-3**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: The UI preserves existing dialogs, tables, fields, stale-data behavior, focus restoration, keyboard navigation, theme tokens, responsive behavior, and reduced-motion support.
- **AUTH-UI-4**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#technical-approach
  - Statement: Viewer restrictions are server-enforced and reflected in the UI without converting unrelated fixture-backed console features to live APIs.

### Reviewer focus

Public versus protected routing, fragment removal before local authorization, exact approved copy, Google-brand button geometry, light/dark-independent auth surfaces, keyboard/focus and reduced-motion behavior, receipt focus restoration, client-safe browser facade calls, and Viewer UI restrictions.

## Task WEB-AUTH-1-6

### Plan contracts

- **AUTH-VERIFY-0**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#test-plan
  - Statement: Unit, OIDC contract, disposable-Postgres integration, HTTP boundary, CLI, and web tests cover the approved lifetimes, copy, role behavior, replay rejection, cookie flags, CSRF/origin checks, final-admin invariant, safe errors, and Viewer restrictions.
- **AUTH-VERIFY-1**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#test-plan
  - Statement: Cleanup searches prove there is no email-keyed identity, first-user-wins branch, browser Bearer credential, /auth/recover, recovery cookie/session, raw token logging, or mock-only Operator role.
- **AUTH-VERIFY-2**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#test-plan
  - Statement: Core and web format, lint, typecheck, build, architecture checks, migration checks, disposable-Postgres suites, and python3 factory/scripts/verify.py complete or report explicit environment-limited gaps.
- **AUTH-VERIFY-3**
  - Source: plans/active/WEB-AUTH-1-authentication-and-access-web-ui.md#test-plan
  - Statement: One autoreview pass covers quality, performance, and security, and the required functional-checker flow is completed because the feature is user-facing.

### Reviewer focus

Disposable database isolation, migration-column coverage, concurrent atomic consume proof, and safe cleanup with no persistent Gantry database access.
