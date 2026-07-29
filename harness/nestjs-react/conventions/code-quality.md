# Code Quality Conventions
> Canon: <!-- canon: constitution/pnp-coding-standards-modular-monolith.md --> — this file only adds NestJS-React scaffold specifics.

Rules optimized for agent-authored codebases. Enforced by linters and CI — not suggestions.

## File Size (Source Code Only)

Applies to: `.ts`, `.tsx`, `.css` files.
Excludes: `.sql`, `.json`, `.prisma`, `.md`, generated files, `*.spec.ts`, `*.e2e-spec.ts`.

| Metric | Limit |
|--------|-------|
| Target | 150 lines |
| Hard max | 200 lines |
| Controllers | 100 lines |

Linter error at hard max:
> "FILE_TOO_LARGE: {{file}} is {{lines}} lines (max 200). Split by responsibility. Each file should have one reason to change. See docs/architecture.md"

Why: Agents load files into context repeatedly (read → edit → verify). Large files burn context budget and increase hallucination risk.

### When to Split (Target Exceeded)

When a service crosses **150 lines**, extract sub-services by domain concern:

**Before (1 file, 195 lines):**
```
projects.service.ts  → CRUD + membership + authorization + slug logic
```

**After (3 files, ~65 lines each):**
```
projects.service.ts           → CRUD orchestration (calls sub-services)
project-membership.service.ts → add/remove/update members
project-authorization.service.ts → ownership checks, role guards
```

Rules:
- The original service becomes the **orchestrator** — it delegates, doesn't implement
- Each extracted service gets its own spec file
- Extracting a utility function (<20 lines) into `*.utils.ts` is fine without a service wrapper
- Never split just to dodge the limit — each piece must have **one reason to change**

## Function Length

| Metric | Limit |
|--------|-------|
| Max body lines | 25 |
| Max cyclomatic complexity | 8 |
| Max nesting depth | 3 |

Early returns over nested conditionals. No nested ternaries.

## Test Coverage

**100% line coverage. No exceptions.**

Rationale (from Logic.inc's production experience):
- At 95%, you're making judgment calls about what to skip
- At 100%, the coverage report IS the todo list — zero ambiguity
- Forces deletion of unreachable code
- Every line has an executable example of how it behaves

Rules:
- Every public service method gets a test
- Test mirrors source: `billing.service.ts` → `billing.service.spec.ts`
- One logical assertion per test (describe blocks group scenarios)
- Test names read as sentences: "should throw when user not found"
- Arrange-Act-Assert structure, always
- Use factories (faker) for test data. Never hardcode values.

## Naming

### Files
- kebab-case, always suffixed with role:

| Suffix | Role |
|--------|------|
| `*.service.ts` | Business logic |
| `*.controller.ts` | HTTP handlers |
| `*.repository.ts` | Data access |
| `*.dto.ts` | Request/response shapes |
| `*.guard.ts` | Auth/access guards |
| `*.filter.ts` | Exception filters |
| `*.strategy.ts` | Passport strategies |
| `*.interceptor.ts` | Request/response transforms |
| `*.pipe.ts` | Input validation/transform |
| `*.client.ts` | External service clients |
| `*.config.ts` | Configuration factories |
| `*.constants.ts` | Named constants |
| `*.mappers.ts` | Entity ↔ DTO mappers |
| `*.errors.ts` | Domain error definitions |
| `*.types.ts` | Shared type definitions |
| `*.decorator.ts` | Custom decorators |
| `*.module.ts` | NestJS modules |

Standalone entry points (`main.ts`, `openapi.ts`) and utility files (`*.utils.ts`) are the only exceptions.

- Directory = domain: `billing/invoice.service.ts` not `utils/helpers.ts`
- No barrel re-exports deeper than 1 level

### Code
- Classes: PascalCase with suffix (`BillingService`, not `Billing`)
- No abbreviations in public APIs: `getUserById`, not `getUsrById`
- Types carry semantic meaning: `UserId`, `WorkspaceSlug`, not `T` or `string`

## Dependencies

- Max 5 constructor injections per class (more = god object, split it)
- No circular dependencies
- Prefer "boring" tech — composable, API-stable, well-represented in training data
- Reimplement small utilities rather than pulling opaque packages (when the utility is <50 lines and needs tight integration)

## Zero Tolerance (Auto-Fail CI)

| Rule | Fix |
|------|-----|
| `any` usage | Use `unknown` + type narrowing |
| `console.log` in production | Use structured logger |
| Commented-out code | Delete it. Git has history. |
| Magic numbers/strings | Extract to named constants |
| `@ts-ignore` / `@ts-expect-error` | Only with linked issue comment |
| Raw Prisma objects in responses | Map to typed DTOs |
| `.skip` or `xit` in tests | Only with linked issue comment |

## Structured Errors

All API errors use a single `AppException` class extending `HttpException`:

```typescript
// common/errors/app-exception.ts
export class AppException extends HttpException {
  constructor(options: {
    status: HttpStatus;
    category: 'VALIDATION' | 'AUTH' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';
    code: string;           // e.g. 'PROJECT_SLUG_TAKEN'
    description: string;    // Human-readable
    retryable?: boolean;    // Default false
  }) { ... }
}
```

Response envelope:
```json
{
  "statusCode": 409,
  "category": "CONFLICT",
  "code": "PROJECT_SLUG_TAKEN",
  "description": "A project with slug 'my-app' already exists",
  "retryable": false
}
```

Rules:
- Never throw raw `HttpException`, `BadRequestException`, etc. — always `AppException`
- Each domain defines its error codes in `*.errors.ts` (e.g. `projects.errors.ts`)
- `category` is one of the 5 values above — no freeform strings
- `retryable: true` only for transient failures (DB timeout, external service down)

## Enforced But Flexible (What, Not How)

| Invariant | Agent Chooses |
|-----------|--------------|
| Parse data at boundary | Zod, class-validator, custom — any works |
| Structured logging | Format enforced, library flexible |
| Error handling | Use `AppException` with category/code/description/retryable |
| API input validation | DTOs required, decorator style is up to agent |

## Explicitly Not Enforced

- Import ordering (Prettier handles it)
- Max module count per domain (organic growth is fine)
- DTO field count (API design review catches this)
- Code style beyond Prettier config (agent output doesn't need to match human aesthetics)

## Boot Time Budget

- Full boot (`install + migrate + seed + dev`): under 60 seconds
- Seed script: under 5 seconds (use factories in tests, not heavy seeds)
- Migration squash: when total exceeds 20 per domain
- `pnpm check:all` (linters): under 10 seconds
- Full test suite: under 120 seconds
