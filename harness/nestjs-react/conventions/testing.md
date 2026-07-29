# Testing Conventions

## Pyramid

| Layer | Tool | Location | Scope |
|-------|------|----------|-------|
| Unit | Vitest | `*.spec.ts` (co-located) | Pure logic, zero I/O |
| Integration | Vitest + Supertest | `apps/api/test/*.int-spec.ts` | Full HTTP path, real DB |
| E2E | Playwright | `apps/web/e2e/` | Critical user journeys only |
| Structural | Custom linters | `pnpm check:all` | File size, imports, naming |

## Coverage

**100% line coverage. No exceptions.** The coverage report IS the todo list.

| Layer | Target | Notes |
|-------|--------|-------|
| Services | 100% | Business logic + every error path |
| Guards | 100% | Allow and deny cases |
| Pipes / Interceptors | 100% | Transform/reject, wrap/modify |
| Controllers | Skip unit tests | Thin wrappers — integration tests cover them |
| `*.module.ts` | Excluded from coverage | NestJS wiring only — no business logic |
| Utils | 100% | Pure functions, easiest to test |

---

## Unit Tests

### Isolation

No database. No network. No filesystem. No `setTimeout`. Pure logic only. If it needs I/O, it's an integration test.

### Mock Strategy

Mock the layer directly below. **Never mock two layers deep.**

| Class Under Test | Mocks |
|-----------------|-------|
| Service | Repository |
| Guard | Reflector, ExecutionContext |
| Pipe | — (pure transform) |
| Interceptor | ExecutionContext, CallHandler |

### Test Factories

Use `@faker-js/faker`. Never hardcode. Factories live in `apps/api/test/factories/`.

> **Shared across stacks:** Frontend tests (React) use the **same** factories from `apps/api/test/factories/`. Import via `@symphony/shared` or direct relative import. One source of truth for test data — don't duplicate factories in the web app.

```typescript
// apps/api/test/factories/user.factory.ts
import { faker } from '@faker-js/faker';
import { User } from '@prisma/client';

export function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: faker.string.uuid(), email: faker.internet.email(),
    name: faker.person.fullName(), role: 'member',
    workspaceId: faker.string.uuid(),
    createdAt: faker.date.recent(), updatedAt: faker.date.recent(),
    ...overrides,
  };
}
```

### Unit Test Pattern

```typescript
// billing/invoice.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InvoiceService } from './invoice.service';
import { InvoiceRepository } from './invoice.repository';
import { buildInvoice } from '../../test/factories/invoice.factory';

describe('InvoiceService', () => {
  let service: InvoiceService;
  let repo: { findById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = { findById: vi.fn() };
    service = new InvoiceService(repo as unknown as InvoiceRepository);
  });

  it('returns invoice by id', async () => {
    const invoice = buildInvoice();
    repo.findById.mockResolvedValue(invoice);
    expect(await service.getById(invoice.id)).toEqual(invoice);
  });

  it('throws NotFoundException when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.getById('x')).rejects.toThrow(NotFoundException);
  });
});
```

### What to Test Per Layer

| Layer | Test These |
|-------|-----------|
| Service | Happy path, every error branch, edge cases (empty arrays, nulls), business rules |
| Guard | `true` for valid claims, `false`/throws for invalid, respects `@Public()` |
| Pipe | Transforms valid input, throws `BadRequestException` on invalid |
| Interceptor | Wraps response shape, modifies headers, handles `next.handle()` errors |

---

## Integration Tests

Each test gets **real Postgres** (worktree's isolated DB) and **real Redis**. No mocks at infrastructure level.

### Transaction Rollback Per Test

Every test runs inside a transaction that rolls back. Faster than truncate, no ordering issues.

```typescript
// apps/api/test/support/test-harness.ts
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AppModule } from '../../src/app.module';

export async function createTestApp() {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

export function withTransaction(app) {
  const prisma = app.get(PrismaService);
  return {
    async run(fn) {
      await prisma.$transaction(async (tx) => {
        Object.assign(prisma, tx);
        try { await fn(prisma); } finally { throw new Error('ROLLBACK'); }
      }).catch((e) => { if (e.message !== 'ROLLBACK') throw e; });
    },
  };
}
```

### Mock JWT Injection

Inject mock JWTs with known claims. Never use real auth flows in tests.

```typescript
// apps/api/test/support/auth.helper.ts
import * as jwt from 'jsonwebtoken';
const TEST_SECRET = 'test-jwt-secret'; // Must match test env JWT_SECRET

export function mockJwt(claims: Record<string, unknown> = {}) {
  return jwt.sign(
    { sub: 'user-123', email: 'test@test.com', role: 'member', ...claims },
    TEST_SECRET, { expiresIn: '1h' },
  );
}

export const authHeader = (c?) => ({ Authorization: `Bearer ${mockJwt(c)}` });
```

### Integration Test Pattern

```typescript
// apps/api/test/invoice.int-spec.ts
import supertest from 'supertest';
import { createTestApp, withTransaction } from './support/test-harness';
import { authHeader } from './support/auth.helper';

describe('POST /api/v1/invoices', () => {
  let app, tx;
  beforeAll(async () => { app = await createTestApp(); tx = withTransaction(app); });
  afterAll(() => app.close());

  it('creates invoice for authed user', () => tx.run(async () => {
    const res = await supertest(app.getHttpServer())
      .post('/api/v1/invoices').set(authHeader({ role: 'admin' }))
      .send({ amount: 5000, currency: 'USD' }).expect(201);
    expect(res.body).toMatchObject({ amount: 5000 });
  }));

  it('rejects unauthenticated', async () => {
    await supertest(app.getHttpServer()).post('/api/v1/invoices').send({}).expect(401);
  });
});
```

### Execution Model

| Scope | Execution |
|-------|-----------|
| Files | Parallel (Vitest default) |
| Tests within a file | Sequential |
| Data setup | Each `describe` creates its own data via factories |
| Cleanup | Transaction rollback — automatic |

### Test Isolation Checklist

- ✅ Each `describe` block creates its own data — no shared fixtures
- ✅ No reliance on seed data or execution order
- ❌ Never share database rows across `describe` blocks

---

## Frontend Testing (React 19.2)

### Setup & File Conventions

Frontend tests live **co-located** with the component: `Button.spec.tsx` next to `Button.tsx`. Vitest 3.x with `@testing-library/react` and `jsdom` environment.

```typescript
// vitest.config.ts (web app)
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
});
```

```typescript
// apps/web/test/setup.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { server } from './mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());
```

### React Testing Library Patterns

Always prefer accessible queries. Render, query via `screen`, interact via `userEvent`.

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('SubmitButton', () => {
  it('calls onSubmit when clicked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SubmitButton onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
```

### Testing React 19.2 Features

#### `useActionState` — Async Form Actions

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Component uses: const [state, submitAction, isPending] = useActionState(createInvoice, initialState);
describe('InvoiceForm', () => {
  it('submits and shows success state', async () => {
    const user = userEvent.setup();
    render(<InvoiceForm />);

    await user.type(screen.getByLabelText('Amount'), '5000');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    // Button shows pending state during async action
    expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();

    // Wait for final state
    expect(await screen.findByText('Invoice created')).toBeInTheDocument();
  });

  it('displays validation errors from action', async () => {
    const user = userEvent.setup();
    render(<InvoiceForm />);

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Amount is required')).toBeInTheDocument();
  });
});
```

#### `useOptimistic` — Optimistic UI

```typescript
// Component uses: const [optimisticItems, addOptimistic] = useOptimistic(items, reducer);
describe('TodoList', () => {
  it('shows item optimistically before server confirms', async () => {
    const user = userEvent.setup();
    render(<TodoList items={[]} />);

    await user.type(screen.getByLabelText('New todo'), 'Buy milk');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // Optimistic item appears immediately (with pending style)
    const item = screen.getByText('Buy milk');
    expect(item).toBeInTheDocument();
    expect(item).toHaveClass('opacity-50'); // visual pending indicator

    // After server confirms, pending style disappears
    await waitFor(() => {
      expect(screen.getByText('Buy milk')).not.toHaveClass('opacity-50');
    });
  });
});
```

#### `<Activity>` — Hidden/Visible Mode Transitions

```typescript
// Component uses: <Activity mode={isVisible ? 'visible' : 'hidden'}>
describe('TabPanel', () => {
  it('preserves state when tab is hidden and re-shown', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TabPanel activeTab="settings" />);

    // Type into settings tab
    await user.type(screen.getByLabelText('Display Name'), 'Ravi');

    // Switch away — Activity mode="hidden"
    rerender(<TabPanel activeTab="profile" />);
    expect(screen.queryByLabelText('Display Name')).not.toBeVisible();

    // Switch back — Activity mode="visible", state preserved
    rerender(<TabPanel activeTab="settings" />);
    expect(screen.getByLabelText('Display Name')).toHaveValue('Ravi');
  });
});
```

#### `use()` Hook — Suspense Boundaries

```typescript
import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';

// Component reads a promise with use(): const data = use(fetchPromise);
describe('UserProfile', () => {
  it('shows loading fallback then resolved data', async () => {
    const userPromise = Promise.resolve({ name: 'Ravi', role: 'admin' });

    render(
      <Suspense fallback={<div>Loading...</div>}>
        <UserProfile dataPromise={userPromise} />
      </Suspense>,
    );

    // Suspense fallback renders first
    expect(screen.getByText('Loading...')).toBeInTheDocument();

    // After promise resolves, content appears
    expect(await screen.findByText('Ravi')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('shows error boundary on rejection', async () => {
    const failPromise = Promise.reject(new Error('Network error'));

    render(
      <ErrorBoundary fallback={<div>Something went wrong</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <UserProfile dataPromise={failPromise} />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  });
});
```

#### `useEffectEvent` — Stable Effect Callbacks

```typescript
// Component uses useEffectEvent to avoid re-running effects when callback values change
describe('ChatRoom', () => {
  it('does not reconnect when onMessage handler changes', () => {
    const connectSpy = vi.fn();
    const { rerender } = render(
      <ChatRoom roomId="general" onMessage={vi.fn()} onConnect={connectSpy} />,
    );
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // Re-render with new onMessage ref — effect should NOT re-fire
    rerender(
      <ChatRoom roomId="general" onMessage={vi.fn()} onConnect={connectSpy} />,
    );
    expect(connectSpy).toHaveBeenCalledTimes(1); // still 1

    // Change roomId — effect SHOULD re-fire
    rerender(
      <ChatRoom roomId="random" onMessage={vi.fn()} onConnect={connectSpy} />,
    );
    expect(connectSpy).toHaveBeenCalledTimes(2);
  });
});
```

### TanStack Query Testing

Wrap components in a fresh `QueryClient` per test. Never share query cache across tests.

```typescript
// apps/web/test/utils/render-with-providers.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

export function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}
```

```typescript
// Test a component that uses useQuery
describe('InvoiceList', () => {
  it('renders invoices from API', async () => {
    // MSW handler returns mock data (see MSW section below)
    renderWithProviders(<InvoiceList workspaceId="ws-1" />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByText('INV-001')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('shows error state on failure', async () => {
    server.use(
      http.get('/api/v1/invoices', () => HttpResponse.json(null, { status: 500 })),
    );
    renderWithProviders(<InvoiceList workspaceId="ws-1" />);

    expect(await screen.findByText('Failed to load invoices')).toBeInTheDocument();
  });
});
```

### Zustand Store Testing

Test stores in isolation. Reset state between tests to prevent leakage.

```typescript
import { beforeEach } from 'vitest';
import { useAuthStore } from './auth.store';

describe('useAuthStore', () => {
  beforeEach(() => {
    // Reset to initial state before each test
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it('sets user on login', () => {
    useAuthStore.getState().login({ id: '1', name: 'Ravi', role: 'admin' });
    expect(useAuthStore.getState().user).toEqual({ id: '1', name: 'Ravi', role: 'admin' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('clears user on logout', () => {
    useAuthStore.getState().login({ id: '1', name: 'Ravi', role: 'admin' });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
  });
});
```

> **Tip:** If your store doesn't expose `getInitialState()`, add it. Or use `useAuthStore.setState({ user: null, isAuthenticated: false })` explicitly.

### MSW (Mock Service Worker)

All frontend API mocking uses MSW. No `vi.mock('fetch')` — MSW intercepts at the network level.

```typescript
// apps/web/test/mocks/handlers.ts
import { http, HttpResponse } from 'msw';
import { buildInvoice } from '../../../api/test/factories/invoice.factory';

export const handlers = [
  http.get('/api/v1/invoices', () => {
    return HttpResponse.json([buildInvoice({ id: 'INV-001' }), buildInvoice()]);
  }),

  http.post('/api/v1/invoices', async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json(buildInvoice(body), { status: 201 });
  }),
];
```

```typescript
// apps/web/test/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

Override handlers per test with `server.use(...)` for error/edge cases (see TanStack Query example above).

### Testing Custom Hooks

Use `renderHook` from `@testing-library/react`. Wrap with providers when hooks depend on context.

```typescript
import { renderHook, act } from '@testing-library/react';
import { useCounter } from './use-counter';

describe('useCounter', () => {
  it('increments count', () => {
    const { result } = renderHook(() => useCounter(0));

    act(() => { result.current.increment(); });
    expect(result.current.count).toBe(1);
  });
});

// Hook that depends on QueryClient
describe('useInvoices', () => {
  it('fetches invoices', async () => {
    const wrapper = ({ children }) => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    };

    const { result } = renderHook(() => useInvoices('ws-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
  });
});
```

### Snapshot Policy

| ✅ Use | ❌ Avoid |
|--------|---------|
| Inline snapshots for small serializable outputs | Full component tree snapshots |
| `toMatchInlineSnapshot()` for error messages, formatted strings | `toMatchSnapshot()` for rendered JSX |

```typescript
// Good — small, readable, catches regressions
expect(formatCurrency(5000, 'USD')).toMatchInlineSnapshot('"$5,000.00"');

// Bad — brittle, nobody reviews 200-line snapshot diffs
expect(container).toMatchSnapshot();
```

Large component snapshots rot: they break on every style/structure change and reviewers rubber-stamp the diff. Test **behavior**, not **markup**.

---

## E2E Tests (Playwright)

Critical user journeys only. **Thin layer** — don't duplicate what integration tests cover.

| ✅ Do test | ❌ Don't test |
|-----------|--------------|
| Login → create → verify in list → delete | Every form validation message |
| Error state renders after failed API call | Individual component behavior |

### Page Object Model

```typescript
// apps/web/e2e/pages/invoice.page.ts
export class InvoicePage {
  constructor(private page: Page) {}
  get createBtn() { return this.page.getByRole('button', { name: 'Create Invoice' }); }
  async create(amount: number) {
    await this.createBtn.click();
    await this.page.getByLabel('Amount').fill(String(amount));
    await this.page.getByRole('button', { name: 'Submit' }).click();
  }
}
```

Visual regression: `toHaveScreenshot()` for layout-critical pages. Snapshots in `apps/web/e2e/__snapshots__/`.

---

## Structural Tests

Run via `pnpm check:all`. Block merge on any violation.

| Check | Script | Catches |
|-------|--------|---------|
| File size | `check-file-size.ts` | Source files over 200 lines |
| Import boundaries | `check-boundaries.ts` | Cross-domain imports, upward deps |
| Naming | `check-naming.ts` | Wrong suffixes, non-kebab filenames |

---

## Rules (Non-Negotiable)

| Rule | Rationale |
|------|-----------|
| No `.skip` / `xit` without linked issue | Dead tests rot silently |
| Factories with faker, never hardcoded | Hardcoded data hides bugs |
| Each test file owns its data | Shared fixtures create coupling |
| `TEST_DATABASE_URL` required for integration | Never hit dev/prod databases |
| No `sleep()` / `setTimeout` in tests | Flaky tests are worse than no tests |
| 100% line coverage, no exceptions | The coverage report IS the todo list |
| No `container.querySelector` in frontend tests | Use `screen.getByRole` / `getByText` — query the DOM like a user |
| No `waitFor` wrapping `getBy*` queries | `findBy*` already waits — `waitFor(getByText(...))` is redundant |
| No testing implementation details | Don't assert state values or hook internals — test what the user sees |
| Test user behavior, not component internals | Click buttons, fill forms, read text — not `component.state.count === 3` |
