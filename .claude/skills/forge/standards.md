# Standards

Forge puts this page in every worker's brief, and reviewers judge each change against it. It opens
with the principles Forge itself follows, then the principles for the apps Forge builds, then the
engineering rules for client code. Each rule gives its reason, so you can apply it with judgement.
If a rule here and the approved story doc disagree, follow the story doc and say so in your handoff.

## Forge's 13 principles

These govern Forge itself. Each has a check: an acceptance criterion, a CI check or a review instruction.

1. Every artifact serves a client-visible change or is cut. Check: every story doc starts with "What changes for you".
2. One home per fact: history in git, review and tests in the PR, current state in `.factory`. Check: no command writes a fact git or GitHub already holds.
3. Gates check outcomes, never rituals: refuse only on real problems — a red test, a P0/P1 finding, a missing approval, or input Forge cannot act on (a malformed doc, the wrong version, a branch outside the lanes). Check: every refusal names the real problem and the next action.
4. Fail loud, early, once: enforce at the command or commit, never silently. Check: a behaviour test for every refusal message.
5. No rule without a test; no test without a rule. Check: the suite maps one test to one rule and tests no internal record format.
6. Forge shrinks over time: every story removes at least as much process as it adds. Check: no module over 1,200 lines, a fixed ceiling on `forge` commands, refactor ratchet in CI.
7. Adapt to third parties, never mirror them (Autoreview, Codex, Claude, GitHub): read only used fields, tolerate new ones, pin versions. Check: one boundary contract test per external tool.
8. The agent does the work; the human decides (approve a story, choose between options, merge). Check: human touches per story are counted; target three or fewer.
9. Same result from any agent: logic in `forge` commands and git, thin host adapters. Check: the same behaviour tests run through both adapters.
10. Slow is a bug: close in minutes, CI under 5 minutes. Check: time per step is recorded and shown on the board; over-budget steps get fixes.
11. Plain English wherever a human looks: no IDs, hashes or jargon on the board, in PR summaries or in questions. Check: reviewed on board and PR text.
12. Reversible by default: every change and every migration is one PR; rollback is a revert. Check: no command changes a client repo outside a branch and PR.
13. Measure the factory: task cycle time, human touches per story, share of PRs fixing Forge instead of the product. Check: these three are the rebuild's success measure.

## The 11 client-app principles

These govern the apps Forge builds for clients. They add no gate, record or command: their checks
run in the cold reads, the review's Simpler rule, the functional check and the check-back.

1. **Problem first.** Every build starts from a job someone does today and what their workaround
   costs. A spec's Why names that problem and its cost, so we can tell whether building paid off.
2. **Smallest slice.** Build the thinnest end-to-end path that moves the success measure, deployed
   where the client can use it. Everything else waits for evidence; no story is only setup.
3. **Only what Done-when needs.** Every task, screen, field, setting, role and integration traces
   to a Done-when item. Anything else is cut, or goes under the spec's Out of scope.
4. **Fewest moving parts.** Climb the ladder below on every change. A new dependency, service,
   datastore, queue, background job or abstraction layer comes last, and only when the story's
   `New moving parts` line names it, because the client pays for it as long as the app runs.
5. **Delete before adding.** Prefer the change that removes a step, screen, field or workaround.
   Replacing behaviour deletes the old path, its tests and its docs in the same change.
6. **One home per fact.** Store each piece of data once; everything else reads or derives it.
   Before adding a table, field, cache, export or sync, name the record that already holds it.
7. **The simplest UI.** One path per job, with the fewest screens, fields, clicks and choices, and
   native controls first. impeccable shapes the visual design and checks it before a demo;
   emil-design-eng makes interaction feel deliberate on every UI, including prototypes.
8. **Measure then check back.** Success means the client's number moved, not that a feature
   shipped. Every spec has a metric, baseline, target and check date. At the check-back the choice
   is to stop, change the slice or remove it; adding more is never the default.
9. **Reversible.** Every change is a pull request a revert undoes. Prefer migrations that only add,
   keep data rather than drop it, and list any one-way step under Risks for the human to decide.
10. **Runnable by a non-technical client.** Errors and empty states say in plain words what
    happened and what to do next, and the README keeps a short, current "How it works".
11. **Security and accessibility never simplified away.** Input is checked where it enters, every
    data access checks permission, secrets and personal data stay out of code and logs, data is
    protected against loss, and every path has keyboard access, labels and readable contrast.
    Choose the simplest option that is still secure, never simply the simplest option.

**The ladder.** Stop at the first rung that holds: does it need software at all; does a Done-when
item need this code; is it already in the repo; the standard library; a platform feature (a
database constraint, an HTML control, a framework built-in); a dependency that's already
installed; one line; then the least new code that works. Mark a deliberate shortcut that has a
known limit with a `ponytail: <limit>, <upgrade path>` comment, so it reads as intent.

## How to work

- **Think before you code.** State your assumptions, and never pick silently. If the brief can be
  read two ways and both readings can be undone, pick the one closer to Done-when and write
  `Ruling: <what> - <why>` in the commit body, so the reviewer sees it. Stop and say so only for a
  one-way step, a security question, a path outside your Scope or a new moving part.
- **Touch only what the task needs.** Match the existing style, don't tidy neighbouring code, and
  mention unrelated dead code instead of deleting it. Remove what your own change left unused.
  Every changed line should trace to the task, so the reviewer can judge it against the story.
- Joining lines or removing blank lines never counts as a reduction.
- **Turn the task into checks first.** A Done-when item becomes a test at the boundary the user
  touches; a bug becomes a test that fails before the fix. Then make them pass.
- **Compatibility is a requirement, not a reflex.** Unless the story names live users, API
  consumers or production data, a replacement deletes the old path: no shims, aliases, fallbacks
  or versioned migrations for data nobody has. When consumers are live, the story says so.
- **Give one recommendation.** When you present options, lead with the one you recommend, its
  reason and how sure you are. A list of options without a stance leaves the work to the reader.
- **Choose technology on purpose.** Use the stack already in the repo first, then the boring,
  widely used option. Anything new goes in the story's `New moving parts` line with the Done-when
  item that needs it. Ask the human only when the options differ in cost, lock-in or
  reversibility.

## Structure only where its concern exists

Structure earns its place by solving a problem the code has today. These rules say where.

- **One deployable app.** Build a modular monolith: one backend, one database, one module per
  business domain. No microservices, and no planning or abstractions for future growth: one app is
  cheaper to run, test and change, and the client pays for today's needs, not guesses.
- **Module boundaries.** A module uses another module only through the service that module
  exports, never through its repository, tables or internal files. This keeps each domain's data
  owned in one place without a message bus. Use in-process events only when one action must
  trigger work in modules that shouldn't know about each other, and name them as a moving part.
- **Thin controllers.** Controllers handle HTTP: parameters, validation, status codes and the
  permission guard. Business logic lives in services, which never see request or response objects.
- **Data access.** Query through the ORM in the service that owns the data. Move queries into a
  repository file when a second service needs them or you need raw SQL, so the SQL has one home.
- **Typed boundaries.** Every endpoint has typed request and response DTOs. Validate input there,
  then trust the types inside. Never return ORM objects: they leak fields the caller shouldn't see.
- **External services behind a provider.** Each external system (payments, email, SMS, a vendor
  API) gets one provider class behind an interface, only because the concern is real: the vendor
  can fail, change or be swapped, and tests need a fake. The provider handles authentication,
  timeouts and retries, maps vendor errors to our error codes, returns our own types and holds no
  business logic. Pure computation is a helper, not a provider.
- **An interface only for an external service or a real second implementation.** One class with
  one implementation needs no interface, factory or base class; add one when the second arrives.
- **Shared code.** Types and validators that both the backend and the frontend use live in the
  shared package, so both sides agree. Add a typed API client there only when the frontend calls
  that API, and a notification module only when a Done-when item sends a notification.
- **File size.** Split a file when it holds two unrelated jobs. Never split a file by line count.
- **Names say the role.** Files are kebab-case with a role suffix (`user.controller.ts`,
  `user.service.ts`, `create-user.dto.ts`, `stripe.provider.ts`, `date.helper.ts`); classes are
  PascalCase with the same suffix (`UserService`); constants are UPPER_SNAKE_CASE.

## The client stack

A new client app starts on the smallest stack that runs its first story: NestJS, Prisma and
Postgres behind a React app built with Vite, in one repo with npm workspaces, tested in CI by
Forge's `tests` check. A repo that already runs another stack keeps it. Anything else arrives only
when a story's `New moving parts` line names it, and that includes Redis and job queues, Terraform,
OIDC sign-in and a monitoring stack.

Forge's package ships a short how-to per concern for this stack in `forge/templates/conventions/`:
`stack.md`, `backend.md`, `api.md`, `database.md`, `frontend.md`, `testing.md` and `security.md`.
Open one only when your task touches its concern; the rules on this page apply either way.
The repo's own rules, its AGENTS.md House rules and conventions, win where they differ from these
default-stack conventions, which apply only to a repo on the default stack.

## APIs

- REST under `/api/v1`, with plural, kebab-case nouns (`/api/v1/payment-transactions`). An action
  that isn't create, read, update or delete is a POST after the resource
  (`POST /api/v1/orders/{id}/cancel`). GET never changes anything.
- Every response uses one envelope, so clients always parse the same fields:
  `{ "success": true, "data": ..., "error": null }`, or on failure
  `{ "success": false, "data": null, "error": { "code", "message", "details", "errorId" } }`.
- Error codes are UPPER_SNAKE_CASE (`ORDER_NOT_FOUND`). The message says in plain words what
  happened and what to do next. Never return stack traces, SQL or library errors, or secrets.
- A validation failure is a 400 with the field errors in `details`; it is normal, not an error.
  The field errors are `details.fieldErrors: [{field, reason}]`, so the UI can place them.
- PUT replaces the whole resource and PATCH changes part; neither is used for an action.
- Filters are plain query params; search is `?search=`.
- Lists take `page` (from 1) and `limit` (20 by default, at most 100) and return
  `data.items` with `data.pagination` (`page`, `limit`, `totalItems`, `totalPages`). Sorting uses
  `sortBy` and `sortOrder` (`asc` or `desc`).
- A breaking change needs a new version while the old one has consumers; with no consumers yet,
  change it in place. Payments, webhooks and retried actions accept an `Idempotency-Key`; the values are stored, so a replay is refused.
- Browser clients that send credentials get CSRF protection.
- Swagger documents every endpoint from its decorators at `/api/docs`: a summary, each field with
  an example, the error responses and the auth it needs. The docs stay true because they're code.

## Errors and logs

- One global exception filter turns every error into the envelope, logs it with an `errorId` and
  the request's `correlationId`, and hides internals. Never swallow an unexpected error: a caught
  error that returns success hides the failure from everyone. Falling back on purpose (a cached
  answer when a vendor times out) is allowed when the code says why and logs a warning.
- Log through the framework's logger as structured JSON, never `console.log`. Each entry has
  `timestampUtc`, `level`, a fixed `message`, a `context` object, `environment`, `serviceName`,
  `module` and `correlationId`, plus `accountId`, `requestId` or `eventId` when there is one.
  A fixed message makes logs searchable; the details go in `context`.
- Log validation failures (4xx) at debug, never as errors.
- Error messages are static text with no interpolated values, so personal data can't slip in.
- Never log passwords, tokens, one-time codes, secrets or personal data; mask what you must keep.
- Levels: `debug` for detail, `info` for normal business events, `warn` for something unexpected
  that didn't fail, `error` for a failed operation, `fatal` when the app can't continue.
- Environments are named `Local`, `Development`, `QA`, `UAT`, `Staging` and `Production`; a project
  has only the ones it uses. Logs go to the console locally and to the host's log service elsewhere.

## Data

- Postgres through Prisma. Tables are PascalCase and singular (`PaymentTransaction`); columns are
  camelCase and don't repeat the table's name (`Order.id`, not `Order.orderId`).
- The primary key is `id`, a UUID. A foreign key is `<entity>Id` (`userId`). Booleans start with
  `is`, `has` or `can`. Times end in `AtUtc` and are stored in UTC; convert to local time only at
  the edges. Durations carry their unit in words (`expiresInSeconds`). Status columns end in
  `Status` (`Order.paymentStatus`) and hold a fixed set of values mapped in application code.
- Every domain table has `id`, `createdAtUtc` and `updatedAtUtc`; once the app has accounts, also
  `createdByAccountId` and `modifiedByAccountId`, so every change has an owner. Deleting is soft
  (`deletedAtUtc`, and `deletedByAccountId` once there are accounts), which protects against loss;
  logs, temporary tables and data the client asked to erase are the exceptions.
- Automated jobs fill the audit fields with a system account.
- Keep tables normalised; copy data only for a measured performance need, and say why. Use a JSON
  column only for metadata that is never queried or joined.
- Index every foreign key and every column a frequent query filters on, as `idx_<Table>_<column>`, and every unique field.
- Many-to-many uses an explicit join table named with both tables in alphabetical order (`RoleUser`).
- Every schema change is a migration with a timestamped name. Never edit a merged migration.
  Prefer migrations that only add; a destructive one goes under the story's Risks.
- Use Postgres full-text search before adding a search engine.
- When a story does add in-process events: name them `<Domain><Action>Event`, give each payload an
  `id`, `version`, `timestampUtc`, `initiatedByAccountId` and `data`, keep secrets out of it, and
  make every handler idempotent by recording the event ids it has processed, since events can
  arrive twice. Handlers never make HTTP calls or call providers directly, catch their own errors,
  and log the event name, id, outcome and duration.

## Frontend

- React with Vite. TanStack Query holds server data; `useState` holds local state; anything a
  shared link should reproduce lives in the URL. Start with a router for the app shell, sign-in,
  protected routes, and 404/403 pages.
- Tailwind with shadcn/ui components, which are accessible by default. impeccable and
  emil-design-eng are required for every UI, prototypes included. impeccable owns layout, type,
  colour, states, copy and the checking pass: shape before building, then audit and polish before
  a demo. Run emil-design-eng's review checklist inside impeccable's one batched inspection;
  allow at most one more checking round. Invoke emil-design-eng with a specific task, never bare.
  It owns press feedback, easing, durations, popovers, tooltips, drag and when not to animate.
- Stagger only when a list appears as a list. Keep routine app-screen motion under 300 ms; a longer
  duration belongs only to one authored landing-page moment. Content is visible by default and
  enters with `@starting-style` or transitions, never hidden until a script runs. Share one
  ease-out token, `cubic-bezier(0.23, 1, 0.32, 1)`. Use CSS or the Web Animations API first; add
  Motion only when a Done-when item needs springs or drag. Treat prototypes as app UI in
  impeccable's Operate mode, where Emil's restraint wins over bold effects. Popovers scale from
  their trigger with shadcn/Radix's transform-origin variable. Do not animate keyboard-driven or
  very frequent actions.
- Every view that loads data handles loading, error and empty. The error says what to do next;
  the empty state says what the screen is for.
- Forms use shadcn Form with react-hook-form and zod, reusing shared validators and showing API
  field errors next to their fields.
- Accessibility is part of done: every control is reachable by keyboard with visible focus,
  inputs have labels, images have alt text, contrast meets WCAG AA, and a click target is a
  `<button>` or a link, never a clickable `<div>`.

## Tests

- Documentation-only changes need no new behaviour test; check claims, commands and links.
- Every Done-when item needs an end-to-end test through the real entry point: Forge's own command;
  for client apps, the running API with a real database and user flows in a browser through
  Playwright. Each bug fix adds a test that fails without the fix. Fake only third-party services
  at their edge.
- Each user-facing Done-when item gets one Playwright browser test; an item with no UI gets an HTTP
  test against the running app and a real database.
- Unit tests are only for pure logic with many cases, never an item's only proof. Review reports
  an item proven only by unit tests as a P1 `Not done` and never asks for unit tests of helpers.
- Tests build their own data with factories, own that data, don't depend on order, and never sleep.
  A skipped test names the reason next to it.
- Client tests create their data through the app's API on a fresh database per run, with no shared
  seed or direct database inserts.
- Playwright retries are zero; fix intermittent failures by waiting for real app state, never by
  adding a fixed sleep.
- New and changed flows get browser tests now; an untouched old flow gets one when a story first
  changes it, with no backfill.
- Test behaviour, not markup or internals. There is no coverage target: a number invites tests
  that prove nothing, and the review's test audit judges each test instead.
- forge.toml's `test` command runs everything CI needs (install, lint, typecheck, all tests), so a
  green run locally means a green `tests` check.

## Code, config and secrets

- TypeScript in strict mode. No `any` (use `unknown` and narrow it), no `@ts-ignore` without a
  reason next to it, no commented-out code (git keeps history), and name a number whose meaning
  isn't obvious.
- Read environment variables in one config module that validates them at start-up, so a missing
  value fails at boot instead of at 3 a.m. Secrets have no defaults, `.env` is never committed, and
  `.env.example` lists every variable with a dummy value.
- Comments explain why, not what.
- Security basics for every API: HTTPS, security headers (helmet), CORS limited to a named list of
  origins, a rate limit on sign-in and other sensitive routes, request validation that rejects
  unknown fields, parameterised queries only, and no `eval`. Once the app has sign-in, every route
  that isn't public checks the caller, and every query is scoped to what the caller may see.

## Git and pull requests

- Forge starts every branch and opens every pull request; nothing lands on the default branch
  except through a reviewed pull request.
- Commit messages are short plain English, and each commit leaves the build working, so any commit
  can be reverted alone.
- `forge close` gives each pull request a plain-English title and a first line saying what changed
  for the client. The squash merge keeps both, and the board's history is built from them.

## Cloud infrastructure

- Once a story adds infrastructure code, every cloud resource is defined there and changes through
  a pull request, never by hand in a console, so each change is reviewed and reversible.
- On AWS, each client has its own organization with an account per environment. Root credentials
  have MFA, no access keys, and are never used for daily work; workloads use roles, not keys.
  The root user's email is a mailing-list address, never a person's.
- Infrastructure as code is Terraform, with `terraform fmt`, TFSec and a cost check in CI, added when
  a story's `New moving parts` line names cloud resources.
- Name cloud resources `<org>-<cloud>-<region>-<environment>-<type>-<project>-<name>` in lowercase,
  and tag each one with its owner, environment and project, so costs and ownership stay traceable.
